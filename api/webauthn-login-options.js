import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { data: creds } = await supabase.from('admin_credentials').select('credential_id');

    if (!creds || creds.length === 0) {
        return res.status(400).json({ message: 'Belum ada fingerprint terdaftar' });
    }

    const options = await generateAuthenticationOptions({
        rpID: process.env.RP_ID,
        userVerification: 'required',
        allowCredentials: creds.map(c => ({ id: c.credential_id })),
    });

    await supabase.from('admin_webauthn_challenge')
        .update({ challenge: options.challenge }).eq('id', 1);

    res.status(200).json(options);
}
