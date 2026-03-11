function normalizeJsonString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

export function decodeCloudSaveMessage(command) {
  if (command && typeof command.messageJson === 'string' && command.messageJson.length > 0) {
    return JSON.parse(command.messageJson);
  }
  if (command && command.message && typeof command.message === 'object') {
    return command.message;
  }
  if (command && command.attributes && typeof command.attributes === 'object') {
    return command.attributes;
  }
  return {};
}

export function buildCloudSearchResult(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    ok: true,
    code: '',
    rows: safeRows.map((row) => ({
      entityType: row?.entity_type || row?.entityType || '',
      id: row?.id || '',
      worldId: Number(row?.world_id ?? row?.worldId ?? 0),
      attributesJson: normalizeJsonString(row?.attributes || {}),
      rankScoresJson: normalizeJsonString(row?.rank_scores || row?.rankScores || {}),
    })),
  };
}

export function buildCloudTopResult(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    ok: true,
    code: '',
    rows: safeRows.map((row) => ({
      entityType: row?.entity_type || row?.entityType || '',
      id: row?.id || '',
      worldId: Number(row?.world_id ?? row?.worldId ?? 0),
      attributesJson: normalizeJsonString(row?.attributes || {}),
      rankScoresJson: normalizeJsonString(row?.rank_scores || row?.rankScores || {}),
      rankValue: Number(row?.rank_value ?? row?.rankValue ?? 0),
    })),
  };
}
