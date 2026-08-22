const fs = require('fs');
const path = require('path');
const os = require('os');

const AppInfoParserModule = require('app-info-parser');
const AppInfoParser = AppInfoParserModule.default || AppInfoParserModule;

// Batas ukuran unduhan — jaga-jaga biar gak timeout/kehabisan memori di serverless.
// APK mod gede (game, dsb) kemungkinan bakal kena limit ini dan minta isi manual.
const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024; // 120MB
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return null;
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Cek apakah buffer beneran file gambar valid (PNG/JPG/WEBP), bukan data rusak/kosong.
// Ini penting karena APK modern sering pakai Adaptive Icon (foreground+background XML),
// yang kadang gagal disusun jadi PNG utuh oleh parser -> hasilnya data corrupt kalau
// nggak divalidasi dulu sebelum di-upload ke ImgBB.
function isValidImageBuffer(buffer) {
    if (!buffer || buffer.length < 200) return false; // terlalu kecil buat jadi icon beneran
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isJpg = buffer[0] === 0xFF && buffer[1] === 0xD8;
    const isWebp = buffer.length > 12 && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    return isPng || isJpg || isWebp;
}

// PENTING: ImgBB migrasi domain hosting gambar dari "i.ibb.co" ke "i.ibb.co.com",
// tapi endpoint upload API mereka masih balikin link pakai domain LAMA yang
// sertifikat SSL-nya rusak (NET::ERR_CERT_COMMON_NAME_INVALID di browser modern).
// Struktur path-nya identik (/KODE/namafile.ext), jadi cukup ganti domainnya saja
// biar gambar bisa dimuat normal.
function fixImgbbDomain(url) {
    if (!url) return url;
    return url.replace('https://i.ibb.co/', 'https://i.ibb.co.com/');
}

// Kenali hosting dari URL, balikin direct-download link asli
async function resolveDirectLink(rawUrl) {
    const url = rawUrl.trim();

    if (/\.apk(\?|$)/i.test(url)) {
        return url; // link direct .apk, langsung pakai
    }

    if (/mediafire\.com/i.test(url)) {
        const pageRes = await fetch(url, { redirect: 'follow' });
        if (!pageRes.ok) throw new Error(`Gagal buka halaman MediaFire (status ${pageRes.status}).`);
        const html = await pageRes.text();
        const match = html.match(/https:\/\/download[\w.-]*\.mediafire\.com\/[^"'<>\s]+/i);
        if (!match) throw new Error('Link download langsung tidak ditemukan di halaman MediaFire (link mungkin sudah invalid).');
        return match[0];
    }

    if (/drive\.google\.com/i.test(url)) {
        const idMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (!idMatch) throw new Error('Tidak bisa membaca ID file dari link Google Drive ini.');
        return `https://drive.usercontent.google.com/download?id=${idMatch[1]}&export=download&confirm=t`;
    }

    throw new Error('Hosting ini belum didukung auto-extract (baru: link .apk langsung, MediaFire, Google Drive). Isi icon & versi manual ya.');
}

async function downloadWithLimit(directUrl) {
    const res = await fetch(directUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Gagal mengunduh file (status ${res.status}).`);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        throw new Error('Link ini mengarah ke halaman HTML, bukan file langsung (mungkin butuh konfirmasi manual dari hosting-nya).');
    }

    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared && declared > MAX_DOWNLOAD_BYTES) {
        throw new Error(`File terlalu besar (${formatBytes(declared)}). Batas auto-extract saat ini ${formatBytes(MAX_DOWNLOAD_BYTES)}. Isi manual ya.`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_DOWNLOAD_BYTES) {
            throw new Error(`File terlalu besar (lebih dari ${formatBytes(MAX_DOWNLOAD_BYTES)}). Isi manual ya.`);
        }
        chunks.push(Buffer.from(value));
    }

    return { buffer: Buffer.concat(chunks), sizeBytes: received };
}

async function uploadBase64ToImgbb(base64Data) {
    if (!IMGBB_API_KEY) throw new Error('IMGBB_API_KEY belum di-set di Environment Variables Vercel.');

    const rawBuffer = Buffer.from(base64Data, 'base64');
    if (!isValidImageBuffer(rawBuffer)) {
        throw new Error('Data gambar tidak valid (kemungkinan Adaptive Icon yang gagal disusun). Upload icon manual ya.');
    }

    const params = new URLSearchParams();
    params.set('image', base64Data);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error('Gagal upload icon ke ImgBB: ' + (data.error?.message || 'Unknown error'));
    }

    return fixImgbbDomain(data.data.url);
}

// Batas ukuran gambar yang di-fetch dari URL internet (icon aja, gak perlu gede-gede)
const MAX_IMAGE_FETCH_BYTES = 20 * 1024 * 1024; // 20MB
// Batas ukuran HTML halaman yang dibaca buat nyari og:image (halaman berat/spam dihindari)
const MAX_HTML_SCAN_BYTES = 3 * 1024 * 1024; // 3MB

const IMAGE_FETCH_HEADERS = {
    // Banyak CDN/hosting nolak request tanpa User-Agent & Referer browser-like
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    'Accept': 'text/html,image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
};

// Cari gambar utama dari sebuah halaman HTML (og:image / twitter:image / <link image_src>).
// Ini yang bikin link non-direct (halaman APKMirror, share.google, dsb) tetap kepakai,
// persis kayak behavior "paste link" bawaan ImgBB.
function extractPageImageUrl(html, baseUrl) {
    const patterns = [
        /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::secure_url)?["']/i,
        /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:image(?::src)?["']/i,
        /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) {
            try { return new URL(m[1], baseUrl).toString(); } catch { return m[1]; }
        }
    }
    return null;
}

// Baca body response gambar dengan validasi ukuran, balikin base64.
async function readImageResponseAsBase64(res) {
    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared && declared > MAX_IMAGE_FETCH_BYTES) {
        throw new Error(`Gambar terlalu besar (${formatBytes(declared)}). Batas ${formatBytes(MAX_IMAGE_FETCH_BYTES)}.`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_IMAGE_FETCH_BYTES) {
            throw new Error(`Gambar terlalu besar (lebih dari ${formatBytes(MAX_IMAGE_FETCH_BYTES)}).`);
        }
        chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks).toString('base64');
}

// Ambil bytes gambar dari URL manapun (server-side, jadi bebas CORS), lalu balikin base64.
// Terima 2 jenis link: (1) link gambar langsung, (2) link halaman (APKMirror, share.google,
// dsb) — kalau halaman, otomatis dicari og:image-nya lalu di-fetch ulang sekali.
async function fetchImageAsBase64(rawUrl, depth = 0) {
    let res;
    try {
        res = await fetch(rawUrl, { redirect: 'follow', headers: IMAGE_FETCH_HEADERS });
    } catch (err) {
        throw new Error('Gagal konek ke URL tersebut (mungkin diblokir hosting-nya atau URL salah).');
    }

    if (!res.ok) {
        throw new Error(`Gagal ambil URL (status ${res.status}). Kemungkinan link diproteksi/dibatasi hosting-nya.`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    if (contentType.startsWith('image/')) {
        return await readImageResponseAsBase64(res);
    }

    if (contentType.includes('text/html') && depth === 0) {
        const declared = parseInt(res.headers.get('content-length') || '0', 10);
        if (declared && declared > MAX_HTML_SCAN_BYTES) {
            throw new Error('Halaman terlalu besar buat dipindai otomatis. Tempel link gambar langsung ya (klik-kanan gambar → "Salin alamat gambar").');
        }
        const html = await res.text();
        const finalBaseUrl = res.url || rawUrl;
        const foundImageUrl = extractPageImageUrl(html, finalBaseUrl);

        if (!foundImageUrl) {
            throw new Error('Halaman ini tidak punya gambar utama yang bisa dideteksi otomatis. Tempel link gambar langsung ya (klik-kanan gambar → "Salin alamat gambar").');
        }

        return await fetchImageAsBase64(foundImageUrl, depth + 1);
    }

    throw new Error('URL yang ditempel bukan gambar atau halaman yang bisa dideteksi (tipe: ' + (contentType || 'tidak diketahui') + ').');
}

// Ambil <title>, meta description, dan gambar (favicon/logo/meta image) dari sebuah
// URL website. Dipakai buat fitur "Auto-Extract Info Website" di form Web Saya.
function extractSiteMeta(html, baseUrl) {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';

    const descPatterns = [
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
        /<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:description["']/i,
        /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:description["']/i,
    ];
    let description = '';
    for (const re of descPatterns) {
        const m = html.match(re);
        if (m && m[1]) { description = m[1].trim().replace(/\s+/g, ' '); break; }
    }

    let domain = '';
    try { domain = new URL(baseUrl).hostname; } catch {}

    // Kalau situsnya emang gak punya meta description sama sekali, jangan dikosongin —
    // generate kalimat default yang masih masuk akal, biar admin gak perlu ngetik manual.
    let descriptionOtomatis = false;
    if (!description) {
        description = title ? `Kunjungi ${title} untuk info lebih lanjut.` : (domain ? `Kunjungi ${domain} untuk info lebih lanjut.` : '');
        descriptionOtomatis = true;
    }

    // Cari gambar apapun yang tersedia di halaman, urut dari yang paling representatif:
    // 1) apple-touch-icon (biasanya resolusi paling tinggi & jelas)
    // 2) favicon/shortcut icon biasa
    // 3) og:image / twitter:image (gambar/logo utama halaman, kalau icon beneran gak ada)
    // Google favicon guesser SENGAJA gak dipakai di sini lagi — dia suka ngasih ikon
    // globe generik buram buat domain yang belum ke-index Google, kelihatan kayak error
    // padahal bukan. Lebih baik ambil dari HTML asli situsnya langsung, atau kosong aja
    // (nanti fallback ke ikon globe bawaan dashboard, itu lebih jujur daripada gambar buram).
    let imgUrl = '';
    const cariTag = (regexList) => {
        for (const re of regexList) {
            const m = html.match(re);
            if (m && m[1]) return m[1];
        }
        return null;
    };

    const appleIcon = cariTag([
        /<link[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]+href=["']([^"']+)["']/i,
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon(?:-precomposed)?["']/i,
    ]);
    const shortcutIcon = cariTag([
        /<link[^>]+rel=["'](?:shortcut icon|icon)["'][^>]+href=["']([^"']+)["']/i,
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut icon|icon)["']/i,
    ]);
    const ogImage = cariTag([
        /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::secure_url)?["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ]);

    const kandidat = appleIcon || shortcutIcon || ogImage;
    if (kandidat) {
        try { imgUrl = new URL(kandidat, baseUrl).toString(); } catch { imgUrl = ''; }
    }
    // Kalau beneran gak ketemu satupun (situsnya polos tanpa icon/logo/meta image),
    // biarin kosong aja — biasa aja, nanti fallback ke ikon globe default. Gak dipaksain.

    return { title, description, descriptionOtomatis, imgUrl, faviconUrl: imgUrl };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method tidak diizinkan' });
    }

    try {
        const { pin, url, mode, imageBase64, imageUrl, siteUrl } = req.body;

        if (!pin || pin !== process.env.ADMIN_PIN) {
            return res.status(401).json({ error: 'PIN salah / akses ditolak.' });
        }

        // MODE: upload gambar manual (drag & drop) — gak butuh APK sama sekali
        if (mode === 'upload_only') {
            if (!imageBase64) return res.status(200).json({ error: 'File gambar tidak ada.' });
            const iconUrl = await uploadBase64ToImgbb(imageBase64);
            return res.status(200).json({ iconUrl });
        }

        // MODE: ambil gambar dari link internet (paste link / drag lintas-tab) — server yang fetch, bebas CORS
        if (mode === 'fetch_url') {
            if (!imageUrl || !imageUrl.trim()) return res.status(200).json({ error: 'Link gambar tidak ada.' });
            if (!/^https?:\/\//i.test(imageUrl.trim())) return res.status(200).json({ error: 'Link gambar tidak valid.' });

            const base64Data = await fetchImageAsBase64(imageUrl.trim());
            const iconUrl = await uploadBase64ToImgbb(base64Data);
            return res.status(200).json({ iconUrl });
        }

        // MODE: ambil nama (title), deskripsi (meta description), & favicon dari URL website.
        // Dipakai form "Tambah/Edit Web Saya" — beda dari mode fetch_url yang khusus icon app.
        if (mode === 'extract_site_meta') {
            if (!siteUrl || !siteUrl.trim()) return res.status(200).json({ error: 'Link website tidak ada.' });
            if (!/^https?:\/\//i.test(siteUrl.trim())) return res.status(200).json({ error: 'Link website tidak valid.' });

            let res2;
            try {
                res2 = await fetch(siteUrl.trim(), { redirect: 'follow', headers: IMAGE_FETCH_HEADERS });
            } catch (err) {
                return res.status(200).json({ error: 'Gagal konek ke website tersebut.' });
            }
            if (!res2.ok) {
                return res.status(200).json({ error: `Gagal ambil halaman (status ${res2.status}).` });
            }
            const contentType = (res2.headers.get('content-type') || '').toLowerCase();
            if (!contentType.includes('text/html')) {
                return res.status(200).json({ error: 'URL ini bukan halaman website (bukan HTML).' });
            }
            const html = await res2.text();
            const info = extractSiteMeta(html, res2.url || siteUrl.trim());
            if (!info.title) {
                return res.status(200).json({ error: 'Gak ketemu title di halaman ini. Isi manual aja.' });
            }
            return res.status(200).json(info);
        }

        // MODE default: extract dari APK
        if (!url || !url.trim()) {
            return res.status(200).json({ error: 'Link download APK wajib diisi.' });
        }

        const directUrl = await resolveDirectLink(url);
        const { buffer, sizeBytes } = await downloadWithLimit(directUrl);

        // app-info-parser lebih stabil dikasih path file ketimbang Buffer mentah
        const tmpPath = path.join(os.tmpdir(), `kyy_apk_${Date.now()}.apk`);
        await fs.promises.writeFile(tmpPath, buffer);

        let versionName = null;
        let iconUrl = null;

        try {
            const parser = new AppInfoParser(tmpPath);
            const info = await parser.parse();
            versionName = info.versionName || null;

            if (info.icon) {
                const base64Only = info.icon.includes(',') ? info.icon.split(',')[1] : info.icon;
                try {
                    iconUrl = await uploadBase64ToImgbb(base64Only);
                } catch (iconErr) {
                    console.error('Icon invalid, dilewati:', iconErr.message);
                    // iconUrl tetap null — biarin admin upload manual/drag&drop
                }
            }
        } catch (parseErr) {
            console.error('Gagal parse APK:', parseErr);
            // tetap lanjut, minimal ukuran file udah kepake
        } finally {
            fs.promises.unlink(tmpPath).catch(() => {});
        }

        return res.status(200).json({
            sizeFormatted: formatBytes(sizeBytes),
            versionName,
            iconUrl
        });

    } catch (err) {
        console.error('extract-apk-info error:', err);
        return res.status(200).json({ error: err.message || 'Gagal memproses link.' });
    }
};
                                 
