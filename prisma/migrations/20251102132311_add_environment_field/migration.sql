-- Add environment column to entities table
ALTER TABLE "entities" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'staging';

-- Drop existing primary key
ALTER TABLE "entities" DROP CONSTRAINT "entities_pkey";

-- Create new composite primary key including environment
ALTER TABLE "entities" ADD CONSTRAINT "entities_pkey" PRIMARY KEY ("environment", "entity_type", "id");

-- Drop old indexes that don't include environment
DROP INDEX IF EXISTS "idx_entity_type_world";
DROP INDEX IF EXISTS "idx_entity_version";
DROP INDEX IF EXISTS "idx_entity_deleted";

-- Create new indexes that include environment for proper isolation
CREATE INDEX "idx_entity_env_type_world" ON "entities"("environment", "entity_type", "world_id");
CREATE INDEX "idx_entity_version" ON "entities"("environment", "entity_type", "id", "version");
CREATE INDEX "idx_entity_deleted" ON "entities"("environment", "entity_type", "world_id", "is_deleted");

-- Remove default value now that migration is complete
ALTER TABLE "entities" ALTER COLUMN "environment" DROP DEFAULT;
