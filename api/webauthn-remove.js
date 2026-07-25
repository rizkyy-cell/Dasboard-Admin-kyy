import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    await supabase.from('admin_credentials').delete().neq('id', 0);
    res.status(200).json({ success: true });
}
