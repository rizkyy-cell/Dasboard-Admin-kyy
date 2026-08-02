import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method tidak diizinkan' });
    }

    try {
        const { pin, email, jumlah } = req.body;

        // 1. Verifikasi PIN admin — samain dengan env var yang dipakai /api/verify-pin kamu.
        //    Kalau nama env var-nya beda, ganti ADMIN_PIN di bawah ini.
        if (!pin || pin !== process.env.ADMIN_PIN) {
            return res.status(401).json({ error: 'PIN salah / akses ditolak.' });
        }

        if (!email || !jumlah || jumlah <= 0) {
            return res.status(400).json({ error: 'Email dan jumlah credit wajib diisi.' });
        }

        if (!supabaseAdmin) {
            return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di server.' });
        }

        // 2. Cari user berdasarkan email lewat Supabase Auth Admin
        const { data: userList, error: errUser } = await supabaseAdmin.auth.admin.listUsers({
            page: 1,
            perPage: 1000
        });
        if (errUser) {
            return res.status(500).json({ error: 'Gagal mengambil daftar user: ' + errUser.message });
        }

        const targetUser = userList.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
        if (!targetUser) {
            return res.status(404).json({ error: `User dengan email ${email} tidak ditemukan. Pastikan dia sudah pernah login.` });
        }

        // 3. Tambah credit lewat RPC (service_role, bypass RLS)
        const { error: errAdd } = await supabaseAdmin.rpc('add_deepsearch_credit', {
            p_user_id: targetUser.id,
            p_jumlah: parseInt(jumlah, 10)
        });
        if (errAdd) {
            return res.status(500).json({ error: 'Gagal menambah credit: ' + errAdd.message });
        }

        // 4. Ambil sisa credit terbaru buat ditampilkan di admin panel
        const { data: creditRow } = await supabaseAdmin
            .from('user_credits')
            .select('deepsearch_credit, is_vip')
            .eq('user_id', targetUser.id)
            .single();

        return res.status(200).json({
            sukses: true,
            email: targetUser.email,
            sisaKredit: creditRow?.deepsearch_credit ?? null
        });

    } catch (err) {
        console.error('admin-add-credit error:', err);
        return res.status(500).json({ error: 'Server error: ' + err.message });
    }
}
