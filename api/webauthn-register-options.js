import { generateRegistrationOptions } from '@simplewebauthn/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const options = await generateRegistrationOptions({
        rpName: 'Web Kyy Admin',
        rpID: process.env.RP_ID,
        userName: 'admin',
        attestationType: 'none',
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required',
        },
    });

    await supabase.from('admin_webauthn_challenge')
        .update({ challenge: options.challenge })
        .eq('id', 1);

    res.status(200).json(options);
}
