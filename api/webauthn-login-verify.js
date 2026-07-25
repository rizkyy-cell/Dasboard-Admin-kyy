import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { data: row } = await supabase
        .from('admin_webauthn_challenge').select('challenge').eq('id', 1).single();

    const { data: cred } = await supabase.from('admin_credentials')
        .select('*').eq('credential_id', req.body.id).single();

    if (!cred) return res.status(400).json({ verified: false });

    const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: row.challenge,
        expectedOrigin: process.env.ORIGIN,
        expectedRPID: process.env.RP_ID,
        credential: {
            id: cred.credential_id,
            publicKey: Buffer.from(cred.public_key, 'base64'),
            counter: cred.counter,
        },
    });

    if (verification.verified) {
        await supabase.from('admin_credentials')
            .update({ counter: verification.authenticationInfo.newCounter })
            .eq('credential_id', cred.credential_id);
        return res.status(200).json({ verified: true });
    }
    res.status(400).json({ verified: false });
}
