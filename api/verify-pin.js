export default function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    
    const { pin } = req.body;
    const correctPin = process.env.ADMIN_PIN;
    
    if (pin === correctPin) {
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
}
