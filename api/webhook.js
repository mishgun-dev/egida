// webhook.js
export default async function handler(req, res) {
    // Лучше получать данные из тела запроса (как это делает MAX),
    // но для теста оставим и query-параметры.
    const { chat_id, text } = req.query;

    if (!chat_id || !text) {
        return res.status(400).json({ error: 'Не переданы chat_id или text' });
    }

    const botToken = process.env.MAX_BOT_TOKEN;
    if (!botToken) {
        return res.status(500).json({ error: 'Токен не найден' });
    }

    try {
        // ПРАВИЛЬНЫЙ ЗАПРОС К API MAX
        const response = await fetch('https://platform-api.max.ru/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // ✅ ГЛАВНОЕ ИСПРАВЛЕНИЕ: Добавлен префикс 'Bearer '
                'Authorization': `Bearer ${botToken}`
            },
            body: JSON.stringify({
                // MAX API ожидает эти поля в таком виде
                chat_id: parseInt(chat_id), // ID должен быть числом
                text: text
            })
        });

        // Обработка ответа от MAX
        const data = await response.json();

        if (!response.ok) {
            // Если MAX API вернул ошибку (например, 400, 401), пробросим её
            console.error('MAX API Error:', response.status, data);
            return res.status(response.status).json({ error: data });
        }

        return res.status(200).json({ success: true, max_response: data });
    } catch (error) {
        console.error('Internal Error:', error);
        return res.status(500).json({ error: error.message });
    }
}