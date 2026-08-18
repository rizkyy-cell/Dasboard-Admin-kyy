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
    return data.data.url;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method tidak diizinkan' });
    }

    try {
        const { pin, url, mode, imageBase64 } = req.body;

        if (!pin || pin !== process.env.ADMIN_PIN) {
            return res.status(401).json({ error: 'PIN salah / akses ditolak.' });
        }

        // MODE: upload gambar manual (drag & drop) — gak butuh APK sama sekali
        if (mode === 'upload_only') {
            if (!imageBase64) return res.status(200).json({ error: 'File gambar tidak ada.' });
            const iconUrl = await uploadBase64ToImgbb(imageBase64);
            return res.status(200).json({ iconUrl });
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
                iconUrl = await uploadBase64ToImgbb(base64Only);
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
