-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "world_id" INTEGER NOT NULL,
    "attributes" JSONB NOT NULL,
    "rank_scores" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("entity_type","id")
);

-- CreateIndex
CREATE INDEX "idx_entity_attributes" ON "entities" USING GIN ("attributes");

-- CreateIndex
CREATE INDEX "idx_entity_rank_scores" ON "entities" USING GIN ("rank_scores");

-- CreateIndex
CREATE INDEX "idx_entity_type_world" ON "entities"("entity_type", "world_id");

-- CreateIndex
CREATE INDEX "idx_entity_version" ON "entities"("entity_type", "id", "version");

-- CreateIndex
CREATE INDEX "idx_entity_deleted" ON "entities"("entity_type", "world_id", "is_deleted");
