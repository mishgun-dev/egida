const DEFAULT_REQUESTS = [
  {
    id: "10021",
    title: "Заявка на обслуживание линии ППУ",
    status: "В работе",
    status_code: "IN_PROCESS",
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "10017",
    title: "Запрос расходников для цеха №2",
    status: "Новая",
    status_code: "NEW",
    created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
  },
];

function mapSmartProcessItem(item) {
  return {
    id: String(item.id || ""),
    title: String(item.title || "Без названия"),
    status: String(item.stageName || item.stageId || "Без статуса"),
    status_code: String(item.stageId || "UNKNOWN"),
    created_at: item.createdTime || null,
  };
}

function toCamelSmartField(fieldName) {
  const raw = String(fieldName || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("UF_CRM_")) return raw;
  const parts = raw.split("_").slice(2).filter(Boolean);
  if (!parts.length) return raw;
  return "ufCrm" + parts.map((part) => part.charAt(0) + part.slice(1).toLowerCase()).join("");
}

function buildFieldCandidates(fieldName) {
  const items = [String(fieldName || "").trim(), toCamelSmartField(fieldName)];
  return [...new Set(items.filter(Boolean))];
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

async function resolveSmartEntityTypeId(webhookUrl, configuredEntityTypeId) {
  if (!configuredEntityTypeId || Number.isNaN(configuredEntityTypeId)) {
    return configuredEntityTypeId;
  }

  if (configuredEntityTypeId >= 1000) {
    return configuredEntityTypeId;
  }

  const typesResult = await callBitrixMethod(webhookUrl, "crm.type.list", {
    order: { id: "asc" },
  });
  const types = Array.isArray(typesResult?.types)
    ? typesResult.types
    : Array.isArray(typesResult)
      ? typesResult
      : [];

  const matchedType = types.find((item) => Number(item.id) === configuredEntityTypeId);
  return Number(matchedType?.entityTypeId || configuredEntityTypeId);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const maxId = String(req.query.max_id || "").trim();
  if (!maxId) {
    return res.status(400).json({ error: "Не передан max_id" });
  }

  const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
  const configuredEntityTypeId = Number(process.env.BITRIX_SMART_ENTITY_TYPE_ID);
  const maxIdField = process.env.BITRIX_MAX_ID_FIELD || "ufCrmMaxId";

  if (!webhookUrl) {
    return res.status(200).json({
      source: "demo",
      items: DEFAULT_REQUESTS,
      note: "Укажите BITRIX_WEBHOOK_URL для загрузки реальных заявок.",
    });
  }

  if (!configuredEntityTypeId || Number.isNaN(configuredEntityTypeId)) {
    return res.status(200).json({
      source: "demo",
      items: DEFAULT_REQUESTS,
      note: "Укажите BITRIX_SMART_ENTITY_TYPE_ID для загрузки заявок из смарт-процесса.",
    });
  }

  try {
    const entityTypeId = await resolveSmartEntityTypeId(webhookUrl, configuredEntityTypeId);
    const fieldCandidates = buildFieldCandidates(maxIdField);
    let smartItems = { items: [] };
    let lastFieldError = null;

    for (const fieldName of fieldCandidates) {
      try {
        smartItems = await callBitrixMethod(webhookUrl, "crm.item.list", {
          entityTypeId,
          filter: { [fieldName]: maxId },
          order: { createdTime: "desc" },
          select: ["id", "title", "stageId", "createdTime"],
          start: 0,
        });
        lastFieldError = null;
        break;
      } catch (error) {
        if (error.code === "INVALID_ARG_VALUE") {
          lastFieldError = error;
          continue;
        }
        throw error;
      }
    }

    if (lastFieldError) {
      throw lastFieldError;
    }

    const fields = await callBitrixMethod(webhookUrl, "crm.item.fields", {
      entityTypeId,
    });

    const stageItems = fields?.fields?.stageId?.items || [];
    const stageMap = new Map(stageItems.map((item) => [item.ID, item.VALUE]));

    const items = (Array.isArray(smartItems?.items) ? smartItems.items : []).map((item) =>
      mapSmartProcessItem({
        ...item,
        stageName: stageMap.get(item.stageId) || item.stageId,
      }),
    );

    return res.status(200).json({ source: "bitrix-smart-process", items });
  } catch (error) {
    return res.status(502).json({
      error: "Не удалось получить заявки из смарт-процесса Bitrix",
      details: error.message,
    });
  }
}
