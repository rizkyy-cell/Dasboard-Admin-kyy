const { createClient } = require('@supabase/supabase-js');

// SERVICE_ROLE key, server-only, bypass RLS — pola sama kayak admin-add-credit.js
let supabaseAdmin = null;
function getSupabaseAdmin() {
    if (supabaseAdmin) return supabaseAdmin;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return supabaseAdmin;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method tidak diizinkan' });
    }

    try {
        const { pin } = req.body;

        // Wajib verifikasi PIN di endpoint ini juga — halaman admin cuma proteksi
        // di sisi tampilan (UI), API ini tetap bisa dipanggil langsung dari luar
        // kalau tidak diverifikasi ulang di server.
        if (!pin || pin !== process.env.ADMIN_PIN) {
            return res.status(401).json({ error: 'PIN salah / akses ditolak.' });
        }

        const admin = getSupabaseAdmin();
        if (!admin) {
            return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di server.' });
        }

        // Ambil semua user dari Supabase Auth (perPage 1000 cukup untuk project personal;
        // kalau suatu saat user tembus 1000+, ini perlu di-loop per halaman)
        const { data: userList, error: errUser } = await admin.auth.admin.listUsers({
            page: 1,
            perPage: 1000
        });
        if (errUser) throw errUser;

        const { data: profiles, error: errProfiles } = await admin
            .from('user_profiles')
            .select('id, permanent_id, username, display_name, photo_url, device_login, last_ip, last_login_at');
        if (errProfiles) throw errProfiles;

        const { data: credits } = await admin
            .from('user_credits')
            .select('user_id, deepsearch_credit, is_vip');

        const profileMap = {};
        (profiles || []).forEach(p => { profileMap[p.id] = p; });

        const creditMap = {};
        (credits || []).forEach(c => { creditMap[c.user_id] = c; });

        const users = userList.users.map(u => {
            const profile = profileMap[u.id] || {};
            const credit = creditMap[u.id] || {};
            return {
                id: u.id,
                email: u.email || '-',
                created_at: u.created_at || null,
                last_sign_in_at: u.last_sign_in_at || null,
                banned_until: u.banned_until || null,
                permanent_id: profile.permanent_id || '-',
                username: profile.username || '-',
                display_name: profile.display_name || '-',
                photo_url: profile.photo_url || null,
                device_login: profile.device_login || '-',
                last_ip: profile.last_ip || '-',
                last_login_at: profile.last_login_at || null,
                deepsearch_credit: credit.deepsearch_credit ?? 0,
                is_vip: !!credit.is_vip
            };
        });

        // User terbaru daftar duluan
        users.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        return res.status(200).json({ users });

    } catch (err) {
        console.error('admin-list-users error:', err);
        return res.status(500).json({ error: 'Gagal mengambil data user: ' + err.message });
    }
};
