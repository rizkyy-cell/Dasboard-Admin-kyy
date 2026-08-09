const { createClient } = require('@supabase/supabase-js');

let supabaseAdmin = null;
function getSupabaseAdmin() {
    if (supabaseAdmin) return supabaseAdmin;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return supabaseAdmin;
}

// Supabase Auth butuh durasi eksplisit buat ban (tidak ada literal "selamanya"),
// jadi dipakai durasi sangat panjang (~100 tahun) supaya efeknya permanen
// sampai di-unban manual oleh admin. Ini menggunakan fitur ban BAWAAN Supabase Auth
// (bukan kolom custom) — begitu di-ban, user itu otomatis gagal login/refresh sesi,
// diberlakukan langsung oleh Supabase sendiri, jadi tidak bisa dibypass dari sisi client.
const PERMANENT_BAN_DURATION = '876000h';

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method tidak diizinkan' });
    }

    try {
        const { pin, userId, action } = req.body;

        if (!pin || pin !== process.env.ADMIN_PIN) {
            return res.status(401).json({ error: 'PIN salah / akses ditolak.' });
        }
        if (!userId || (action !== 'ban' && action !== 'unban')) {
            return res.status(400).json({ error: 'Parameter tidak lengkap.' });
        }

        const admin = getSupabaseAdmin();
        if (!admin) {
            return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di server.' });
        }

        const banDuration = action === 'ban' ? PERMANENT_BAN_DURATION : 'none';
        const { data, error } = await admin.auth.admin.updateUserById(userId, { ban_duration: banDuration });
        if (error) throw error;

        return res.status(200).json({
            success: true,
            banned_until: data.user.banned_until || null
        });

    } catch (err) {
        console.error('admin-ban-user error:', err);
        return res.status(500).json({ error: 'Gagal memproses aksi: ' + err.message });
    }
};
