-- AlterTable
ALTER TABLE "products" ADD COLUMN     "excerptSecondary" TEXT,
ADD COLUMN     "profiles" VARCHAR(191);

-- CreateTable
CREATE TABLE "product_highlights" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_highlights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_highlights_productId_order_idx" ON "product_highlights"("productId", "order");

-- AddForeignKey
ALTER TABLE "product_highlights" ADD CONSTRAINT "product_highlights_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
