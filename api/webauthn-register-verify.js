import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { data: row } = await supabase
        .from('admin_webauthn_challenge').select('challenge').eq('id', 1).single();

    const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: row.challenge,
        expectedOrigin: process.env.ORIGIN,
        expectedRPID: process.env.RP_ID,
    });

    if (verification.verified) {
        const { credential } = verification.registrationInfo;
        await supabase.from('admin_credentials').insert({
            credential_id: credential.id,
            public_key: Buffer.from(credential.publicKey).toString('base64'),
            counter: credential.counter,
        });
        return res.status(200).json({ verified: true });
    }
    res.status(400).json({ verified: false });
}
