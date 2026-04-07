export default async function handler(req, res) {
    const { user_id, text } = req.query;

    if (!user_id || !text) {
        return res.status(400).json({ error: 'Не переданы обязательные параметры: user_id или text' });
    }

    const botToken = process.env.MAX_BOT_TOKEN;

    if (!botToken) {
        return res.status(500).json({ error: 'Токен не найден в переменных окружения' });
    }

    try {
        const response = await fetch('https://platform-api.max.ru/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': botToken
            },
            body: JSON.stringify({
                chat_id: user_id,
                text: text
            })
        });

        const data = await response.json();
        
        return res.status(200).json({ success: true, max_response: data });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}