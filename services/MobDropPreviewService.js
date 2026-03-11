const REQUIRED_SNAPSHOT_FILES = Object.freeze([
  'mob.json',
  'cloud.json',
  'map.json',
  'Mob.nx.json',
  'Augment.nx.json',
  'String.nx.json',
]);

const JOB_GROUPS = Object.freeze([-1, 1, 2, 3, 4, 5]);
const BASE_JOB_GROUP = 0;

function createPreviewError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function toInteger(value) {
  return Math.trunc(Number(value) || 0);
}

function toNumber(value) {
  return Number(value) || 0;
}

function clampProbability(value) {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function combineProbabilities(currentValue, nextValue) {
  return 1 - ((1 - currentValue) * (1 - nextValue));
}

export class MobDropPreviewService {
  constructor({ snapshotReader }) {
    this.snapshotReader = snapshotReader;
  }

  async previewMobDrops({ environment, mobId }) {
    const parsedMobId = toInteger(mobId);
    if (parsedMobId <= 0) {
      throw createPreviewError('mobId must be a positive integer', 'invalid_mob_id');
    }

    const snapshot = await this.snapshotReader.getCurrentSnapshot(environment, REQUIRED_SNAPSHOT_FILES);
    const missingData = REQUIRED_SNAPSHOT_FILES.filter((fileName) => snapshot.files[fileName] == null);
    if (missingData.length > 0) {
      throw createPreviewError('Required snapshot files are missing', 'missing_snapshot_files', {
        missingData,
      });
    }

    const mobConfig = snapshot.files['mob.json'];
    const cloudConfig = snapshot.files['cloud.json'];
    const mapConfig = snapshot.files['map.json'];
    const mobNx = snapshot.files['Mob.nx.json'];
    const augmentNx = snapshot.files['Augment.nx.json'];
    const stringNx = snapshot.files['String.nx.json'];

    const mobEntry = this.getMobEntry(mobNx, parsedMobId);
    if (!mobEntry || !mobEntry.info) {
      throw createPreviewError(`Mob ${parsedMobId} was not found in Mob.nx.json`, 'mob_not_found');
    }

    const labelIndex = this.buildLabelIndex(stringNx);
    const bossTypes = this.resolveBossTypes(mapConfig, parsedMobId);
    const profiles = [];

    if (bossTypes.length === 0) {
      profiles.push(this.buildProfile({
        mobId: parsedMobId,
        bossType: '',
        mobInfo: mobEntry.info,
        mobConfig,
        cloudConfig,
        augmentNx,
        labelIndex,
        unresolvedBossContext: mobEntry.info.boss === true,
      }));
    } else {
      for (const bossType of bossTypes) {
        profiles.push(this.buildProfile({
          mobId: parsedMobId,
          bossType,
          mobInfo: mobEntry.info,
          mobConfig,
          cloudConfig,
          augmentNx,
          labelIndex,
          unresolvedBossContext: false,
        }));
      }
    }

    return {
      snapshotVersion: snapshot.manifest.snapshotVersion,
      manifestId: snapshot.manifest.manifestId || snapshot.manifest.manifestHash || null,
      mob: {
        id: parsedMobId,
        name: this.resolveMobName(labelIndex, parsedMobId),
        level: toInteger(mobEntry.info.level),
        boss: mobEntry.info.boss === true,
      },
      missingData: [],
      profiles,
    };
  }

  getMobEntry(mobNx, mobId) {
    const mobKey = String(mobId);
    if (mobNx.all && mobNx.all[mobKey]) {
      return mobNx.all[mobKey];
    }
    return mobNx[mobKey] || null;
  }

  resolveBossTypes(mapConfig, mobId) {
    const result = [];
    const seen = new Set();
    const bosses = mapConfig?.bosses || {};
    for (const [bossType, bossConfig] of Object.entries(bosses)) {
      for (const spawn of bossConfig.spawns || []) {
        if (toInteger(spawn.mobId) !== mobId) {
          continue;
        }
        if (!seen.has(bossType)) {
          seen.add(bossType);
          result.push(bossType);
        }
      }
    }
    return result;
  }

  buildProfile({
    mobId,
    bossType,
    mobInfo,
    mobConfig,
    cloudConfig,
    augmentNx,
    labelIndex,
    unresolvedBossContext,
  }) {
    const warnings = [];
    const dropContext = this.resolveDropGroupContext({
      mobInfo,
      mobConfig,
      bossType,
      warnings,
    });
    if (unresolvedBossContext) {
      warnings.push('Boss-specific drop groups could not be resolved from map.json for this mob.');
    }

    const itemMap = new Map();
    const level = toInteger(mobInfo.level);
    this.addMesoDrop(itemMap, mobConfig, level);

    for (const dropConfig of mobConfig.globalDrops || []) {
      const evaluation = this.evaluateGlobalDropRule({
        dropConfig,
        matchedGroups: dropContext.groups,
        difficulty: dropContext.difficulty,
        mobInfo,
        augmentNx,
        warnings,
      });
      if (!evaluation.applies) {
        continue;
      }

      for (const itemId of evaluation.itemIds) {
        this.addOrMergeDrop(itemMap, {
          itemId,
          name: this.resolveItemName(labelIndex, itemId),
          approxChance: evaluation.chance,
          sourceKinds: ['global'],
          jobRestricted: dropConfig.jobRestricted === true,
          conditional: dropConfig.jobRestricted === true,
          quantity: evaluation.quantity,
          notes: evaluation.notes,
        });
      }
    }

    const cloudDropConfig = cloudConfig?.mobDrops?.[String(mobId)];
    if (cloudDropConfig && cloudDropConfig.itemIds) {
      const cloudChance = clampProbability(toNumber(mobConfig?.combat?.cloudMobDropChance));
      for (const [rawItemId, questOnly] of Object.entries(cloudDropConfig.itemIds)) {
        const itemId = toInteger(rawItemId);
        if (itemId <= 0) {
          continue;
        }
        this.addOrMergeDrop(itemMap, {
          itemId,
          name: this.resolveItemName(labelIndex, itemId),
          approxChance: cloudChance,
          sourceKinds: ['cloud'],
          questOnly: questOnly === true,
          conditional: questOnly === true,
          notes: questOnly === true ? ['Quest-only cloud drop.'] : [],
          quantity: {
            min: 1,
            max: 1,
          },
        });
      }
    }

    const items = [...itemMap.values()]
      .sort((left, right) => {
        if (right.approxChance !== left.approxChance) {
          return right.approxChance - left.approxChance;
        }
        return left.itemId - right.itemId;
      })
      .map((item) => ({
        ...item,
        approxChance: Number(item.approxChance.toFixed(6)),
      }));

    return {
      bossType,
      difficulty: dropContext.difficulty,
      matchedGroups: Object.keys(dropContext.groups).sort(),
      warnings,
      items,
    };
  }

  addMesoDrop(itemMap, mobConfig, level) {
    const minRate = toNumber(mobConfig?.mobMinMesoRate);
    const maxRate = Math.max(minRate, toNumber(mobConfig?.mobMaxMesoRate));
    const minAmount = Math.max(0, Math.floor(level * minRate));
    const maxAmount = Math.max(minAmount, Math.floor(level * maxRate));
    if (maxAmount <= 0) {
      return;
    }

    this.addOrMergeDrop(itemMap, {
      kind: 'meso',
      itemId: 0,
      name: 'Mesos',
      approxChance: 1,
      sourceKinds: ['meso'],
      quantity: {
        min: minAmount,
        max: maxAmount,
      },
      notes: ['Approximate meso amount per kill.'],
    });
  }

  evaluateGlobalDropRule({ dropConfig, matchedGroups, difficulty, mobInfo, augmentNx, warnings }) {
    const mobLevel = toInteger(mobInfo.level);
    if (toInteger(dropConfig.minLevel) > 0 && mobLevel < toInteger(dropConfig.minLevel)) {
      return { applies: false };
    }
    if (toInteger(dropConfig.maxLevel) > 0 && mobLevel > toInteger(dropConfig.maxLevel)) {
      return { applies: false };
    }
    if (difficulty < toInteger(dropConfig.minDifficulty)) {
      return { applies: false };
    }
    if (toInteger(dropConfig.maxDifficulty) > 0 && difficulty > toInteger(dropConfig.maxDifficulty)) {
      return { applies: false };
    }
    if (!this.isDropGroupAllowed(dropConfig, matchedGroups)) {
      return { applies: false };
    }

    const itemIds = this.collectGlobalDropItems(dropConfig, augmentNx, warnings);
    if (itemIds.length === 0) {
      return { applies: false };
    }

    const baseChance = clampProbability(
      toNumber(dropConfig.chance) + (toNumber(dropConfig.difficultyScalingChance) * difficulty),
    );
    if (baseChance <= 0) {
      return { applies: false };
    }

    const extraCountUpper = Math.max(0, Math.floor(toNumber(dropConfig.difficultyScalingCount) * difficulty));
    const notes = [];
    if (extraCountUpper > 0) {
      notes.push(`Quantity varies from 1 to ${1 + extraCountUpper}.`);
    }

    return {
      applies: true,
      itemIds,
      chance: baseChance,
      quantity: {
        min: 1,
        max: 1 + extraCountUpper,
      },
      notes,
    };
  }

  resolveDropGroupContext({ mobInfo, mobConfig, bossType, warnings }) {
    const matchedGroups = {};
    let maxDifficulty = 0;
    const groups = mobConfig?.mobGroups || {};
    const hasHpTag = toInteger(mobInfo.hpTagColor) > 0;
    const rareItemDropLevel = toInteger(mobInfo.rareItemDropLevel);
    const isEliteMob = false;
    const isEliteBoss = false;
    const isNormalMob = mobInfo.boss !== true && !isEliteBoss;
    const explosive = toInteger(mobInfo.explosiveReward) > 0;

    for (const [groupName, group] of Object.entries(groups)) {
      let applies = false;
      if (bossType) {
        if ((group.bossTypes || []).includes(bossType)) {
          applies = true;
        }
      } else {
        applies = true;
        if (toInteger(group.rareItemDropLevel) > 0 && rareItemDropLevel !== toInteger(group.rareItemDropLevel)) {
          applies = false;
        }
        if (applies && group.hasHpTag === true && !hasHpTag) {
          applies = false;
        }
        if (applies && group.eliteMob === true && !isEliteMob) {
          applies = false;
        }
        if (applies && group.normalMob === true && !isNormalMob) {
          applies = false;
        }
        if (applies && group.explosive === true && !explosive) {
          applies = false;
        }
        if (applies && group.arcaneSfMob === true) {
          applies = false;
          warnings.push(`Skipped group ${groupName} because arcane/star-force map context is not available in published config.`);
        }
      }

      if (applies) {
        matchedGroups[groupName] = true;
        maxDifficulty = Math.max(maxDifficulty, toInteger(group.difficulty));
      }
    }

    return {
      groups: matchedGroups,
      difficulty: maxDifficulty,
    };
  }

  isDropGroupAllowed(dropConfig, matchedGroups) {
    if (dropConfig.mobGroup && dropConfig.mobGroup.length > 0 && matchedGroups[dropConfig.mobGroup] !== true) {
      return false;
    }
    if (!dropConfig.mobGroups || dropConfig.mobGroups.length === 0) {
      return true;
    }
    return dropConfig.mobGroups.some((groupName) => matchedGroups[groupName] === true);
  }

  collectGlobalDropItems(dropConfig, augmentNx, warnings) {
    const seen = new Set();
    for (const itemId of dropConfig.itemIds || []) {
      const parsedItemId = toInteger(itemId);
      if (parsedItemId > 0) {
        seen.add(parsedItemId);
      }
    }

    const jobGroups = dropConfig.jobRestricted === true ? JOB_GROUPS : [BASE_JOB_GROUP];
    for (const prefixId of dropConfig.itemPrefixes || []) {
      this.collectAugmentDropItems(seen, augmentNx, 'P', prefixId, jobGroups, warnings);
    }
    for (const suffixId of dropConfig.itemSuffixes || []) {
      this.collectAugmentDropItems(seen, augmentNx, 'S', suffixId, jobGroups, warnings);
    }
    for (const setId of dropConfig.sets || []) {
      this.collectAugmentDropItems(seen, augmentNx, 'I', setId, jobGroups, warnings);
    }

    return [...seen].sort((left, right) => left - right);
  }

  collectAugmentDropItems(seen, augmentNx, keyPrefix, categoryId, jobGroups, warnings) {
    let matchedAnyKey = false;
    for (const jobGroup of jobGroups) {
      const keys = [
        `${keyPrefix}:${categoryId}:0:0:${jobGroup}`,
        `${categoryId}::${jobGroup}`,
      ];

      for (const key of keys) {
        const itemSetInfo = augmentNx?.itemPrefixes?.[key];
        if (!itemSetInfo || !itemSetInfo.itemIds) {
          continue;
        }

        matchedAnyKey = true;
        for (const [rawItemId, enabled] of Object.entries(itemSetInfo.itemIds)) {
          if (enabled !== true) {
            continue;
          }
          const itemId = toInteger(rawItemId);
          if (itemId > 0) {
            seen.add(itemId);
          }
        }
      }
    }

    if (!matchedAnyKey) {
      warnings.push(`Augment lookup missing for ${keyPrefix}:${categoryId}.`);
    }
  }

  buildLabelIndex(stringNx) {
    const itemNames = new Map();
    const categories = ['cash', 'ins', 'pet', 'consume', 'etc', 'eqp'];
    for (const category of categories) {
      const entries = stringNx?.[category] || {};
      for (const [rawId, value] of Object.entries(entries)) {
        const itemId = toInteger(rawId);
        if (itemId <= 0) {
          continue;
        }
        if (typeof value === 'string') {
          itemNames.set(itemId, value);
          continue;
        }
        if (value && typeof value.name === 'string' && value.name.length > 0) {
          itemNames.set(itemId, value.name);
        }
      }
    }

    return {
      itemNames,
      mobNames: stringNx?.mob || {},
    };
  }

  resolveItemName(labelIndex, itemId) {
    return labelIndex.itemNames.get(itemId) || String(itemId);
  }

  resolveMobName(labelIndex, mobId) {
    return labelIndex.mobNames[String(mobId)] || String(mobId);
  }

  addOrMergeDrop(itemMap, item) {
    const key = `${item.kind || 'item'}:${item.itemId}`;
    if (!itemMap.has(key)) {
      itemMap.set(key, {
        kind: item.kind || 'item',
        itemId: item.itemId,
        name: item.name,
        approxChance: clampProbability(item.approxChance),
        sourceKinds: [...new Set(item.sourceKinds || [])],
        jobRestricted: item.jobRestricted === true,
        questOnly: item.questOnly === true,
        conditional: item.conditional === true,
        quantity: item.quantity || {
          min: 1,
          max: 1,
        },
        notes: [...new Set(item.notes || [])],
      });
      return;
    }

    const existing = itemMap.get(key);
    existing.approxChance = combineProbabilities(existing.approxChance, clampProbability(item.approxChance));
    existing.sourceKinds = [...new Set(existing.sourceKinds.concat(item.sourceKinds || []))];
    existing.jobRestricted = existing.jobRestricted || item.jobRestricted === true;
    existing.questOnly = existing.questOnly || item.questOnly === true;
    existing.conditional = existing.conditional || item.conditional === true;
    existing.quantity = {
      min: Math.min(existing.quantity.min, item.quantity?.min ?? existing.quantity.min),
      max: Math.max(existing.quantity.max, item.quantity?.max ?? existing.quantity.max),
    };
    existing.notes = [...new Set(existing.notes.concat(item.notes || []))];
  }
}
