const DEFAULT_LIMIT = 4;

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDialogId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `chat${raw}`;
  return raw;
}

function normalizeBitrixText(value) {
  return String(value || "")
    .replace(/\[br\s*\/?\]/gi, "\n")
    .replace(/\[USER=[^\]]+\]([^\[]+)\[\/USER\]/gi, "$1")
    .replace(/\[URL=[^\]]+\]([^\[]+)\[\/URL\]/gi, "$1")
    .replace(/\[(\/?)(b|i|u|s|quote|code)\]/gi, "")
    .replace(/\[(?:COLOR|SIZE|FONT|LEFT|RIGHT|CENTER|JUSTIFY)[^\]]*\]/gi, "")
    .replace(/\[\/(?:COLOR|SIZE|FONT|LEFT|RIGHT|CENTER|JUSTIFY)\]/gi, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function callBitrixMethod(webhookUrl, method, body) {
  const base = webhookUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/${method}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    const error = new Error(data.error_description || data.error || `Bitrix request failed: ${response.status}`);
    error.code = data.error || null;
    error.status = response.status;
    throw error;
  }

  return data.result;
}

async function getWebhookScopes(webhookUrl) {
  const result = await callBitrixMethod(webhookUrl, "scope", {});
  return Array.isArray(result) ? result : [];
}

function buildUsersMap(users) {
  const map = new Map();
  const items = Array.isArray(users) ? users : Object.values(users || {});

  items.forEach((user) => {
    const id = Number(user?.id);
    if (!id) return;

    const fullName = String(
      user.name ||
        [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
        `Пользователь ${id}`,
    ).trim();

    map.set(id, fullName);
  });

  return map;
}

async function resolveDialogId(webhookUrl, configuredDialogId, configuredChannelName) {
  const directDialogId = normalizeDialogId(configuredDialogId);
  if (directDialogId) return directDialogId;

  const channelName = String(configuredChannelName || "").trim();
  if (!channelName) return "";

  let offset = 0;
  const normalizedChannelName = channelName.toLowerCase();

  while (offset <= 400) {
    const recent = await callBitrixMethod(webhookUrl, "im.recent.list", {
      ONLY_CHANNEL: "Y",
      SKIP_OPENLINES: "Y",
      SKIP_DIALOG: "Y",
      SKIP_CHAT: "N",
      OFFSET: offset,
      LIMIT: 200,
      PARSE_TEXT: "N",
      GET_ORIGINAL_TEXT: "N",
    });

    const items = Array.isArray(recent?.items) ? recent.items : [];
    const exactMatch = items.find((item) => String(item?.title || "").trim().toLowerCase() === normalizedChannelName);
    const fuzzyMatch = items.find((item) => String(item?.title || "").trim().toLowerCase().includes(normalizedChannelName));
    const matchedItem = exactMatch || fuzzyMatch;

    if (matchedItem) {
      return normalizeDialogId(matchedItem.id || (matchedItem.chat_id ? `chat${matchedItem.chat_id}` : ""));
    }

    if (!recent?.hasMore || !items.length) {
      break;
    }

    offset += 200;
  }

  return "";
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const webhookUrl = String(process.env.BITRIX_NEWS_WEBHOOK_URL || process.env.BITRIX_WEBHOOK_URL || "").trim();
  const configuredDialogId = process.env.BITRIX_NEWS_DIALOG_ID;
  const configuredChannelName = process.env.BITRIX_NEWS_CHANNEL_NAME;
  const limit = Math.min(toPositiveInt(req.query.limit, toPositiveInt(process.env.BITRIX_NEWS_LIMIT, DEFAULT_LIMIT)), 10);

  if (!webhookUrl) {
    return res.status(200).json({
      source: "setup",
      items: [],
      note: "Добавьте BITRIX_NEWS_WEBHOOK_URL с доступом к Bitrix IM, чтобы показывать новости из канала.",
    });
  }

  try {
    const scopes = await getWebhookScopes(webhookUrl);
    if (!scopes.includes("im")) {
      return res.status(200).json({
        source: "setup",
        items: [],
        note: "Текущий вебхук Bitrix не имеет scope im. Создайте отдельный входящий вебхук с доступом к чату и укажите его в BITRIX_NEWS_WEBHOOK_URL.",
      });
    }

    const dialogId = await resolveDialogId(webhookUrl, configuredDialogId, configuredChannelName);
    if (!dialogId) {
      return res.status(200).json({
        source: "setup",
        items: [],
        note: "Укажите BITRIX_NEWS_DIALOG_ID или BITRIX_NEWS_CHANNEL_NAME, чтобы привязать ленту новостей к каналу Bitrix.",
      });
    }

    const result = await callBitrixMethod(webhookUrl, "im.dialog.messages.get", {
      DIALOG_ID: dialogId,
      LIMIT: Math.min(limit * 3, 30),
    });

    const usersMap = buildUsersMap(result?.users);
    const items = (Array.isArray(result?.messages) ? result.messages : [])
      .filter((message) => Number(message?.author_id) > 0)
      .map((message) => {
        const text = normalizeBitrixText(message?.text);
        if (!text) return null;

        return {
          id: String(message.id || ""),
          text,
          author: usersMap.get(Number(message.author_id)) || "Сотрудник",
          created_at: message.date || null,
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    return res.status(200).json({
      source: "bitrix-channel",
      dialog_id: dialogId,
      items,
    });
  } catch (error) {
    if (error.code === "insufficient_scope" || error.code === "ACCESS_DENIED" || error.code === "INVALID_CREDENTIALS") {
      return res.status(200).json({
        source: "setup",
        items: [],
        note: "Bitrix отклонил доступ к сообщениям канала. Для этой ленты нужен вебхук со scope im и пользователь-участник канала.",
      });
    }

    return res.status(502).json({
      error: "Не удалось получить новости из Bitrix-канала",
      details: error.message,
    });
  }
}
