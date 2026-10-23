ALTER TABLE "rooms" ADD COLUMN "categories" jsonb DEFAULT '["Państwo","Miasto","Roślina / Zwierzę","Imię","Rzecz"]' NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "total_rounds" integer DEFAULT 1 NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "round" integer DEFAULT 0 NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "answers" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "votes" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "scores" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "rooms" ADD COLUMN "round_scores" jsonb DEFAULT '{}' NOT NULL;
