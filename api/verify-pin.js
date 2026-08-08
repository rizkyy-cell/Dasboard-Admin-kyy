const { createClient } = require('@supabase/supabase-js');

// Pakai SERVICE_ROLE key (server-only, bypass RLS) — sama pola kayak chat_custom.js & storage.js
let supabaseAdmin = null;
function getSupabaseAdmin() {
    if (supabaseAdmin) return supabaseAdmin;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return supabaseAdmin;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 menit

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const admin = getSupabaseAdmin();
    if (!admin) {
        return res.status(500).json({
            success: false,
            message: 'Server belum dikonfigurasi (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di Vercel).'
        });
    }

    const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    const now = Date.now();

    // 1. Cek histori percobaan IP ini dari Supabase (persisten, tidak reset saat cold start)
    const { data: row } = await admin
        .from('admin_login_attempts')
        .select('count, first_attempt')
        .eq('ip', ip)
        .maybeSingle();

    if (row) {
        const elapsed = now - new Date(row.first_attempt).getTime();

        if (elapsed > WINDOW_MS) {
            // Sudah lewat 15 menit -> reset histori percobaan
            await admin.from('admin_login_attempts').delete().eq('ip', ip);
        } else if (row.count >= MAX_ATTEMPTS) {
            const sisaMenit = Math.ceil((WINDOW_MS - elapsed) / 60000);
            return res.status(429).json({
                success: false,
                message: `Terlalu banyak percobaan! Coba lagi dalam ${sisaMenit} menit.`
            });
        }
    }

    const { pin } = req.body;
    const correctPin = process.env.ADMIN_PIN;

    if (pin && correctPin && pin === correctPin) {
        // Berhasil -> hapus histori percobaan gagal untuk IP ini
        await admin.from('admin_login_attempts').delete().eq('ip', ip);
        return res.status(200).json({ success: true });
    }

    // Gagal -> tambah/insert counter percobaan
    if (row) {
        await admin
            .from('admin_login_attempts')
            .update({ count: row.count + 1 })
            .eq('ip', ip);
    } else {
        await admin
            .from('admin_login_attempts')
            .insert({ ip, count: 1, first_attempt: new Date().toISOString() });
    }

    return res.status(401).json({ success: false });
};
