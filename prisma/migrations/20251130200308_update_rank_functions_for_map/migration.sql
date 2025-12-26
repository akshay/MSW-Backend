-- Update ranking function to support map<int32, int64> structure
-- rankKey format is now "scoreType:partitionKey" (e.g., "kills:1", "score:2")
CREATE OR REPLACE FUNCTION get_ranked_entities(
  p_environment TEXT,
  p_entity_type TEXT,
  p_world_id INT,
  rank_key TEXT,
  sort_order TEXT DEFAULT 'DESC',
  limit_count INT DEFAULT 100
)
RETURNS TABLE(entity_type TEXT, id TEXT, world_id INT, attributes JSONB, rank_scores JSONB, rank_value BIGINT) AS $$
DECLARE
  score_type TEXT;
  partition_key TEXT;
BEGIN
  -- Parse rankKey into scoreType and partitionKey
  -- Format: "scoreType:partitionKey" (e.g., "kills:1")
  score_type := split_part(rank_key, ':', 1);
  partition_key := split_part(rank_key, ':', 2);

  -- Validate that we have both parts
  IF score_type = '' OR partition_key = '' THEN
    RAISE EXCEPTION 'Invalid rank_key format. Expected "scoreType:partitionKey", got "%"', rank_key;
  END IF;

  RETURN QUERY EXECUTE format('
    SELECT
      e.entity_type,
      e.id,
      e.world_id,
      e.attributes,
      e.rank_scores,
      (e.rank_scores->%L->>%L)::BIGINT as rank_value
    FROM entities e
    WHERE e.environment = %L
      AND e.entity_type = %L
      AND e.world_id = %s
      AND e.is_deleted = false
      AND e.rank_scores ? %L
      AND e.rank_scores->%L ? %L
      AND e.rank_scores->%L->>%L IS NOT NULL
    ORDER BY (e.rank_scores->%L->>%L)::BIGINT %s
    LIMIT %s',
    score_type, partition_key,
    p_environment, p_entity_type, p_world_id,
    score_type, score_type, partition_key, score_type, partition_key,
    score_type, partition_key, sort_order, limit_count
  );
END;
$$ LANGUAGE plpgsql;

-- Update name search function to include environment parameter
CREATE OR REPLACE FUNCTION get_entities_by_name(
  p_environment TEXT,
  p_entity_type TEXT,
  name_pattern TEXT,
  p_world_id INT DEFAULT NULL,
  limit_count INT DEFAULT 100
)
RETURNS TABLE(entity_type TEXT, id TEXT, world_id INT, attributes JSONB, rank_scores JSONB) AS $$
BEGIN
  IF p_world_id IS NOT NULL THEN
    -- Search within specific world
    RETURN QUERY
    SELECT e.entity_type, e.id, e.world_id, e.attributes, e.rank_scores
    FROM entities e
    WHERE e.environment = p_environment
      AND e.entity_type = p_entity_type
      AND e.world_id = p_world_id
      AND e.is_deleted = false
      AND e.attributes->>'name' ILIKE '%' || name_pattern || '%'
    ORDER BY e.attributes->>'name'
    LIMIT limit_count;
  ELSE
    -- Search across all worlds
    RETURN QUERY
    SELECT e.entity_type, e.id, e.world_id, e.attributes, e.rank_scores
    FROM entities e
    WHERE e.environment = p_environment
      AND e.entity_type = p_entity_type
      AND e.is_deleted = false
      AND e.attributes->>'name' ILIKE '%' || name_pattern || '%'
    ORDER BY e.world_id, e.attributes->>'name'
    LIMIT limit_count;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Update batch upsert function to include environment parameter
CREATE OR REPLACE FUNCTION batch_upsert_entities_partial(
  entity_data JSONB
)
RETURNS JSONB AS $$
DECLARE
  entity_record JSONB;
  result_array JSONB := '[]'::jsonb;
  operation_result JSONB;
  merged_attributes JSONB;
  merged_rank_scores JSONB;
  key_to_remove TEXT;
  existing_entity RECORD;
  is_create BOOLEAN;
  is_delete BOOLEAN;
  existing_is_deleted BOOLEAN;
  new_version INT;
  p_environment TEXT;
BEGIN
  FOR entity_record IN SELECT jsonb_array_elements(entity_data)
  LOOP
    -- Extract environment from entity record
    p_environment := entity_record->>'environment';

    -- Determine operation type
    is_create := COALESCE((entity_record->>'is_create')::BOOLEAN, false);
    is_delete := COALESCE((entity_record->>'is_delete')::BOOLEAN, false);

    -- Check if entity exists
    SELECT *, is_deleted INTO existing_entity
    FROM entities
    WHERE environment = p_environment
      AND entity_type = entity_record->>'entity_type'
      AND id = entity_record->>'id';

    existing_is_deleted := COALESCE(existing_entity.is_deleted, false);

    -- Validation: reject creates when entity exists (and not deleted)
    IF is_create AND existing_entity.id IS NOT NULL AND NOT existing_is_deleted THEN
      operation_result := jsonb_build_object(
        'success', false,
        'error', 'ENTITY_ALREADY_EXISTS',
        'entity_type', entity_record->>'entity_type',
        'id', entity_record->>'id'
      );
      result_array := result_array || operation_result;
      CONTINUE;
    END IF;

    -- Validation: reject updates when entity doesn't exist or is deleted
    IF NOT is_create AND NOT is_delete AND (existing_entity.id IS NULL OR existing_is_deleted) THEN
      operation_result := jsonb_build_object(
        'success', false,
        'error', 'ENTITY_NOT_FOUND',
        'entity_type', entity_record->>'entity_type',
        'id', entity_record->>'id'
      );
      result_array := result_array || operation_result;
      CONTINUE;
    END IF;

    -- Validation: reject deletes when entity doesn't exist or already deleted
    IF is_delete AND (existing_entity.id IS NULL OR existing_is_deleted) THEN
      operation_result := jsonb_build_object(
        'success', false,
        'error', 'ENTITY_NOT_FOUND',
        'entity_type', entity_record->>'entity_type',
        'id', entity_record->>'id'
      );
      result_array := result_array || operation_result;
      CONTINUE;
    END IF;

    -- Handle DELETE operation
    IF is_delete THEN
      UPDATE entities
      SET is_deleted = true,
          version = version + 1,
          updated_at = NOW()
      WHERE environment = p_environment
        AND entity_type = entity_record->>'entity_type'
        AND id = entity_record->>'id'
      RETURNING version INTO existing_entity.version;

      operation_result := jsonb_build_object(
        'success', true,
        'entity_type', entity_record->>'entity_type',
        'id', entity_record->>'id',
        'operation', 'delete',
        'version', existing_entity.version
      );
      result_array := result_array || operation_result;
      CONTINUE;
    END IF;

    -- Handle CREATE or UPDATE operations
    -- Start with existing attributes or empty object
    IF existing_entity.id IS NOT NULL THEN
      merged_attributes := COALESCE(existing_entity.attributes, '{}'::jsonb);
      merged_rank_scores := COALESCE(existing_entity.rank_scores, '{}'::jsonb);
    ELSE
      merged_attributes := '{}'::jsonb;
      merged_rank_scores := '{}'::jsonb;
    END IF;

    -- Merge new attributes
    merged_attributes := merged_attributes || (entity_record->'attributes')::jsonb;

    -- Remove keys marked for deletion (attributes_keys_to_remove array)
    IF entity_record ? 'attributes_keys_to_remove' THEN
      FOR key_to_remove IN
        SELECT jsonb_array_elements_text(entity_record->'attributes_keys_to_remove')
      LOOP
        merged_attributes := merged_attributes #- string_to_array(key_to_remove, '.');
      END LOOP;
    END IF;

    -- Handle rank scores (nested map structure)
    IF entity_record ? 'rank_scores' THEN
      -- Deep merge rank scores to support map<int32, int64> structure
      -- For each score type in the new data
      DECLARE
        score_type_key TEXT;
        score_type_value JSONB;
      BEGIN
        FOR score_type_key, score_type_value IN
          SELECT * FROM jsonb_each(entity_record->'rank_scores')
        LOOP
          -- If the score type doesn't exist in merged_rank_scores, add it
          IF NOT (merged_rank_scores ? score_type_key) THEN
            merged_rank_scores := merged_rank_scores || jsonb_build_object(score_type_key, score_type_value);
          ELSE
            -- Merge the maps for this score type
            merged_rank_scores := jsonb_set(
              merged_rank_scores,
              ARRAY[score_type_key],
              COALESCE(merged_rank_scores->score_type_key, '{}'::jsonb) || score_type_value
            );
          END IF;
        END LOOP;
      END;

      -- Remove keys marked for deletion
      IF entity_record ? 'rank_scores_keys_to_remove' THEN
        FOR key_to_remove IN
          SELECT jsonb_array_elements_text(entity_record->'rank_scores_keys_to_remove')
        LOOP
          merged_rank_scores := merged_rank_scores #- string_to_array(key_to_remove, '.');
        END LOOP;
      END IF;
    END IF;

    -- Perform upsert with merged and cleaned data
    INSERT INTO entities (
      environment,
      entity_type,
      id,
      world_id,
      attributes,
      rank_scores,
      version,
      is_deleted,
      updated_at
    )
    VALUES (
      p_environment,
      entity_record->>'entity_type',
      entity_record->>'id',
      (entity_record->>'world_id')::INT,
      merged_attributes,
      merged_rank_scores,
      1,
      false,
      NOW()
    )
    ON CONFLICT (environment, entity_type, id)
    DO UPDATE SET
      world_id = (entity_record->>'world_id')::INT,
      attributes = merged_attributes,
      rank_scores = merged_rank_scores,
      version = entities.version + 1,
      is_deleted = false,
      updated_at = NOW()
    RETURNING version INTO new_version;

    operation_result := jsonb_build_object(
      'success', true,
      'entity_type', entity_record->>'entity_type',
      'id', entity_record->>'id',
      'operation', CASE WHEN is_create THEN 'create' ELSE 'update' END,
      'version', new_version
    );
    result_array := result_array || operation_result;
  END LOOP;

  RETURN jsonb_build_object('results', result_array, 'total', jsonb_array_length(result_array));
END;
$$ LANGUAGE plpgsql;
