const attempts = {};

export default function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const ip = req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();

    // Reset attempts kalau sudah lebih dari 15 menit
    if (attempts[ip] && now - attempts[ip].time > 15 * 60 * 1000) {
        delete attempts[ip];
    }

    // Blokir kalau sudah salah 5x
    if (attempts[ip] && attempts[ip].count >= 5) {
        const sisaWaktu = Math.ceil((15 * 60 * 1000 - (now - attempts[ip].time)) / 60000);
        return res.status(429).json({ 
            success: false, 
            message: `Terlalu banyak percobaan! Coba lagi dalam ${sisaWaktu} menit.` 
        });
    }

    const { pin } = req.body;
    const correctPin = process.env.ADMIN_PIN;

    if (pin === correctPin) {
        delete attempts[ip]; // Reset kalau berhasil
        res.status(200).json({ success: true });
    } else {
        attempts[ip] = {
            count: (attempts[ip]?.count || 0) + 1,
            time: attempts[ip]?.time || now
        };
        res.status(401).json({ success: false });
    }
}
