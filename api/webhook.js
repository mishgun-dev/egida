export default async function handler(req, res) {
    const { chat_id, text } = req.query;

    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!chat_id || !text) {
        return res.status(400).json({ error: 'Не переданы обязательные параметры: chat_id или text' });
    }

    const botToken = process.env.MAX_BOT_TOKEN;

    if (!botToken) {
        return res.status(500).json({ error: 'Токен не найден в переменных окружения' });
    }

    try {
        const url = `https://platform-api.max.ru/messages?user_id=${encodeURIComponent(String(chat_id))}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Согласно документации MAX API: Authorization: <token>
                'Authorization': botToken
            },
            body: JSON.stringify({
                text: String(text)
            })
        });

        const data = await response.json();
        
        return res.status(response.status).json({ success: response.ok, max_response: data });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}