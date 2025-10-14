-- Simplified upsert function (worldId always required)
CREATE OR REPLACE FUNCTION upsert_entity_partial(
  p_entity_type TEXT,
  p_entity_id TEXT,
  p_world_id INT,
  partial_attributes JSONB,
  partial_rank_scores JSONB DEFAULT NULL
)
RETURNS TABLE(entity_type TEXT, id TEXT, world_id INT, attributes JSONB, rank_scores JSONB, version INT, updated_at TIMESTAMPTZ)
AS $$
BEGIN
  INSERT INTO entities (entity_type, id, world_id, attributes, rank_scores, version, updated_at)
  VALUES (
    p_entity_type,
    p_entity_id,
    p_world_id,
    partial_attributes,
    partial_rank_scores,
    1,
    NOW()
  )
  ON CONFLICT (entity_type, id)
  DO UPDATE SET
    -- Update world_id (entity might move between worlds)
    world_id = p_world_id,
    -- Atomic JSONB merge: existing || new
    attributes = COALESCE(entities.attributes, '{}'::jsonb) || partial_attributes,
    -- Merge rank scores
    rank_scores = CASE
      WHEN partial_rank_scores IS NOT NULL THEN
        COALESCE(entities.rank_scores, '{}'::jsonb) || partial_rank_scores
      ELSE entities.rank_scores
    END,
    -- Increment version on update
    version = entities.version + 1,
    updated_at = NOW()
  RETURNING entities.entity_type, entities.id, entities.world_id, entities.attributes, entities.rank_scores, entities.version, entities.updated_at;
END;
$$ LANGUAGE plpgsql;

-- Batch upsert function with create/update/delete operation support
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
BEGIN
  FOR entity_record IN SELECT jsonb_array_elements(entity_data)
  LOOP
    -- Determine operation type
    is_create := COALESCE((entity_record->>'is_create')::BOOLEAN, false);
    is_delete := COALESCE((entity_record->>'is_delete')::BOOLEAN, false);

    -- Check if entity exists
    SELECT *, is_deleted INTO existing_entity
    FROM entities
    WHERE entity_type = entity_record->>'entity_type'
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
      WHERE entity_type = entity_record->>'entity_type'
        AND id = entity_record->>'id';

      operation_result := jsonb_build_object(
        'success', true,
        'entity_type', entity_record->>'entity_type',
        'id', entity_record->>'id',
        'operation', 'delete'
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
        merged_attributes := merged_attributes - key_to_remove;
      END LOOP;
    END IF;

    -- Handle rank scores
    IF entity_record ? 'rank_scores' THEN
      -- Merge new rank scores
      merged_rank_scores := merged_rank_scores || (entity_record->'rank_scores')::jsonb;

      -- Remove keys marked for deletion
      IF entity_record ? 'rank_scores_keys_to_remove' THEN
        FOR key_to_remove IN
          SELECT jsonb_array_elements_text(entity_record->'rank_scores_keys_to_remove')
        LOOP
          merged_rank_scores := merged_rank_scores - key_to_remove;
        END LOOP;
      END IF;
    END IF;

    -- Perform upsert with merged and cleaned data
    INSERT INTO entities (
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
      entity_record->>'entity_type',
      entity_record->>'id',
      (entity_record->>'world_id')::INT,
      merged_attributes,
      merged_rank_scores,
      1,
      false,
      NOW()
    )
    ON CONFLICT (entity_type, id)
    DO UPDATE SET
      world_id = (entity_record->>'world_id')::INT,
      attributes = merged_attributes,
      rank_scores = merged_rank_scores,
      version = entities.version + 1,
      is_deleted = false,
      updated_at = NOW();

    operation_result := jsonb_build_object(
      'success', true,
      'entity_type', entity_record->>'entity_type',
      'id', entity_record->>'id',
      'operation', CASE WHEN is_create THEN 'create' ELSE 'update' END
    );
    result_array := result_array || operation_result;
  END LOOP;

  RETURN jsonb_build_object('results', result_array, 'total', jsonb_array_length(result_array));
END;
$$ LANGUAGE plpgsql;

-- Simplified ranking function (single world only)
CREATE OR REPLACE FUNCTION get_ranked_entities(
  p_entity_type TEXT,
  p_world_id INT,
  rank_key TEXT,
  sort_order TEXT DEFAULT 'DESC',
  limit_count INT DEFAULT 100
)
RETURNS TABLE(entity_type TEXT, id TEXT, world_id INT, attributes JSONB, rank_scores JSONB, rank_value FLOAT) AS $$
BEGIN
  RETURN QUERY EXECUTE format('
    SELECT
      e.entity_type,
      e.id,
      e.world_id,
      e.attributes,
      e.rank_scores,
      (e.rank_scores->>%L)::FLOAT as rank_value
    FROM entities e
    WHERE e.entity_type = %L
      AND e.world_id = %s
      AND e.is_deleted = false
      AND e.rank_scores ? %L
      AND e.rank_scores->>%L IS NOT NULL
    ORDER BY (e.rank_scores->>%L)::FLOAT %s
    LIMIT %s',
    rank_key, p_entity_type, p_world_id, rank_key, rank_key, rank_key, sort_order, limit_count
  );
END;
$$ LANGUAGE plpgsql;

-- Name search function (worldId optional)
CREATE OR REPLACE FUNCTION get_entities_by_name(
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
    WHERE e.entity_type = p_entity_type
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
    WHERE e.entity_type = p_entity_type
      AND e.is_deleted = false
      AND e.attributes->>'name' ILIKE '%' || name_pattern || '%'
    ORDER BY e.world_id, e.attributes->>'name'
    LIMIT limit_count;
  END IF;
END;
$$ LANGUAGE plpgsql;
