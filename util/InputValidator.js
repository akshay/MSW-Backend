// Input validation and sanitization utility
export class InputValidator {
  // Special marker to indicate a key should be removed from nested JSON
  // Using special characters to prevent collision with actual data
  static NULL_MARKER = '$$__NULL__$$';

  /**
   * Check if a value is the special null marker
   */
  static isNullMarker(value) {
    return value === this.NULL_MARKER;
  }

  /**
   * Validate and sanitize entity type
   * Entity types should be alphanumeric with underscores only
   */
  static sanitizeEntityType(entityType) {
    if (typeof entityType !== 'string') {
      throw new Error('Entity type must be a string');
    }

    // Allow only alphanumeric characters and underscores
    if (!/^[a-zA-Z0-9_]+$/.test(entityType)) {
      throw new Error(`Invalid entity type: ${entityType}. Only alphanumeric characters and underscores allowed.`);
    }

    // Limit length to prevent abuse
    if (entityType.length > 64) {
      throw new Error('Entity type must be 64 characters or less');
    }

    return entityType;
  }

  /**
   * Validate and sanitize entity ID
   * Entity IDs should be alphanumeric with hyphens and underscores
   */
  static sanitizeEntityId(entityId) {
    if (typeof entityId !== 'string' && typeof entityId !== 'number') {
      throw new Error('Entity ID must be a string or number');
    }

    const idStr = String(entityId);

    // Allow alphanumeric, hyphens, and underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(idStr)) {
      throw new Error(`Invalid entity ID: ${idStr}. Only alphanumeric characters, hyphens, and underscores allowed.`);
    }

    // Limit length
    if (idStr.length > 128) {
      throw new Error('Entity ID must be 128 characters or less');
    }

    return idStr;
  }

  /**
   * Validate world ID
   */
  static sanitizeWorldId(worldId) {
    const numWorldId = parseInt(worldId, 10);

    if (isNaN(numWorldId) || numWorldId < 0) {
      throw new Error('World ID must be a non-negative integer');
    }

    return numWorldId;
  }

  /**
   * Validate rank key
   */
  static sanitizeRankKey(rankKey) {
    if (typeof rankKey !== 'string') {
      throw new Error('Rank key must be a string');
    }

    // Allow only alphanumeric characters and underscores
    if (!/^[a-zA-Z0-9_]+$/.test(rankKey)) {
      throw new Error(`Invalid rank key: ${rankKey}. Only alphanumeric characters and underscores allowed.`);
    }

    if (rankKey.length > 64) {
      throw new Error('Rank key must be 64 characters or less');
    }

    return rankKey;
  }

  /**
   * Validate sort order
   */
  static sanitizeSortOrder(sortOrder) {
    const validOrders = ['ASC', 'DESC', 'asc', 'desc'];

    if (!validOrders.includes(sortOrder)) {
      throw new Error('Sort order must be ASC or DESC');
    }

    return sortOrder.toUpperCase();
  }

  /**
   * Validate limit parameter
   */
  static sanitizeLimit(limit, max = 1000) {
    const numLimit = parseInt(limit, 10);

    if (isNaN(numLimit) || numLimit < 1) {
      throw new Error('Limit must be a positive integer');
    }

    if (numLimit > max) {
      throw new Error(`Limit must be ${max} or less`);
    }

    return numLimit;
  }

  /**
   * Sanitize name pattern for search
   * Prevents SQL injection through LIKE patterns
   */
  static sanitizeNamePattern(pattern) {
    if (typeof pattern !== 'string') {
      throw new Error('Name pattern must be a string');
    }

    // Limit length
    if (pattern.length > 32) {
      throw new Error('Name pattern must be 32 characters or less');
    }

    // Escape special SQL characters that could be used in injection
    // Allow wildcards % and _ for LIKE queries, but escape backslashes
    const sanitized = pattern
      .replace(/\\/g, '\\\\')  // Escape backslashes
      .replace(/'/g, "''");     // Escape single quotes (SQL standard)

    return sanitized;
  }

  /**
   * Validate stream ID
   */
  static sanitizeStreamId(streamId) {
    if (typeof streamId !== 'string') {
      throw new Error('Stream ID must be a string');
    }

    // Allow alphanumeric, colons, hyphens, and underscores (common in stream IDs)
    if (!/^[a-zA-Z0-9:_-]+$/.test(streamId)) {
      throw new Error(`Invalid stream ID: ${streamId}. Only alphanumeric characters, colons, hyphens, and underscores allowed.`);
    }

    if (streamId.length > 256) {
      throw new Error('Stream ID must be 256 characters or less');
    }

    return streamId;
  }

  /**
   * Sanitize attributes object
   * Validates that attributes don't contain dangerous values
   * Handles special NULL_MARKER for key removal, including nested keys
   */
  static sanitizeAttributes(attributes, options = {}) {
    if (!attributes || typeof attributes !== 'object') {
      throw new Error('Attributes must be an object');
    }

    if (Array.isArray(attributes)) {
      throw new Error('Attributes must be an object, not an array');
    }

    const { processNullMarkers = true } = options;
    const keysToRemove = [];
    const sanitized = this.sanitizeAttributesRecursive(
      attributes,
      { processNullMarkers },
      keysToRemove,
      ''
    );

    return { sanitized, keysToRemove };
  }

  /**
   * Recursively sanitize attributes and collect NULL_MARKER removal paths
   */
  static sanitizeAttributesRecursive(attributes, options, keysToRemove, pathPrefix) {
    const sanitized = {};

    for (const [key, value] of Object.entries(attributes)) {
      const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;

      // Validate key format
      if (!/^[a-zA-Z0-9_]+$/.test(key)) {
        throw new Error(`Invalid attribute key: ${key}. Only alphanumeric characters and underscores allowed.`);
      }

      if (key.length > 64) {
        throw new Error(`Attribute key too long: ${key}`);
      }

      // Check for NULL_MARKER - indicates key should be removed
      if (options.processNullMarkers && this.isNullMarker(value)) {
        keysToRemove.push(currentPath);
        continue; // Don't add to sanitized object
      }

      // Validate value types (prevent injection through complex objects)
      if (value !== null && value !== undefined) {
        const valueType = typeof value;

        if (valueType === 'object') {
          if (Array.isArray(value) || value.constructor !== Object) {
            throw new Error(`Invalid attribute value type for ${currentPath}: object. Only plain objects are allowed.`);
          }

          if (Object.keys(value).length === 0) {
            sanitized[key] = {};
            continue;
          }

          const nestedSanitized = this.sanitizeAttributesRecursive(
            value,
            options,
            keysToRemove,
            currentPath
          );

          if (Object.keys(nestedSanitized).length > 0) {
            sanitized[key] = nestedSanitized;
          }

          continue;
        }

        if (!['string', 'number', 'boolean'].includes(valueType)) {
          throw new Error(`Invalid attribute value type for ${currentPath}: ${valueType}. Only string, number, boolean, or null allowed.`);
        }

        if (valueType === 'string' && value.length > 10000) {
          throw new Error(`Attribute value too long for ${currentPath}`);
        }
      }

      sanitized[key] = value;
    }

    return sanitized;
  }

  /**
   * Sanitize batch data for database insertion
   * Handles NULL_MARKER for key removal in attributes and rank_scores
   */
  static sanitizeBatchData(batchData) {
    if (!Array.isArray(batchData)) {
      throw new Error('Batch data must be an array');
    }

    return batchData.map((item, index) => {
      try {
        const { sanitized: attributes, keysToRemove: attributeKeysToRemove } =
          this.sanitizeAttributes(item.attributes);

        const result = {
          entity_type: this.sanitizeEntityType(item.entity_type),
          id: this.sanitizeEntityId(item.id),
          world_id: this.sanitizeWorldId(item.world_id),
          is_create: item.is_create === true,
          is_delete: item.is_delete === true,
          attributes,
          attributes_keys_to_remove: attributeKeysToRemove
        };

        if (item.rank_scores) {
          const { sanitized: rankScores, keysToRemove: rankKeysToRemove } =
            this.sanitizeAttributes(item.rank_scores);
          result.rank_scores = rankScores;
          result.rank_scores_keys_to_remove = rankKeysToRemove;
        }

        return result;
      } catch (error) {
        throw new Error(`Validation error at batch index ${index}: ${error.message}`);
      }
    });
  }

  /**
   * Validate and sanitize world instance ID
   * Used for rate limiting and authentication
   */
  static sanitizeWorldInstanceId(worldInstanceId) {
    if (typeof worldInstanceId !== 'string') {
      throw new Error('World instance ID must be a string');
    }

    // Allow alphanumeric, hyphens, and underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(worldInstanceId)) {
      throw new Error(`Invalid world instance ID: ${worldInstanceId}. Only alphanumeric characters, hyphens, and underscores allowed.`);
    }

    // Limit length to prevent abuse
    if (worldInstanceId.length < 1 || worldInstanceId.length > 128) {
      throw new Error('World instance ID must be between 1 and 128 characters');
    }

    return worldInstanceId;
  }

  /**
   * Validate IP address format
   * Supports both IPv4 and IPv6
   */
  static sanitizeIpAddress(ip) {
    if (typeof ip !== 'string') {
      throw new Error('IP address must be a string');
    }

    // IPv4 regex
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    // IPv6 regex (simplified - matches most common patterns)
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

    const isIPv4 = ipv4Regex.test(ip);
    const isIPv6 = ipv6Regex.test(ip);

    if (!isIPv4 && !isIPv6 && ip !== 'unknown') {
      throw new Error(`Invalid IP address format: ${ip}`);
    }

    // Validate IPv4 octets are in valid range (0-255)
    if (isIPv4) {
      const octets = ip.split('.').map(Number);
      if (octets.some(octet => octet > 255)) {
        throw new Error(`Invalid IPv4 address: ${ip}. Octets must be 0-255`);
      }
    }

    return ip;
  }
}
