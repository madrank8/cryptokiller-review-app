import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * POST /api/sync/review
 * Webhook called by the Vercel admin when a review is published.
 * Upserts review data into the Replit PostgreSQL database.
 * Auth: Bearer token matching SYNC_SECRET env var.
 */
router.post("/sync/review", async (req, res) => {
  try {
    // Auth check
    const syncSecret = process.env.SYNC_SECRET;
    if (!syncSecret) {
      return res.status(500).json({ error: "SYNC_SECRET not configured" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "").trim();
    if (token !== syncSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { review, brand } = req.body;
    if (!review || !brand) {
      return res.status(400).json({ error: "review and brand are required" });
    }

    const slug = review.slug || brand.slug;
    if (!slug) {
      return res.status(400).json({ error: "slug is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ─── 1. Upsert platform ───
      const platformResult = await client.query(
        `INSERT INTO platforms (name, slug, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (slug) DO UPDATE SET name = $1, updated_at = NOW()
         RETURNING id`,
        [brand.name || review.title || slug, slug]
      );
      const platformId = platformResult.rows[0].id;

      // ─── 2. Upsert review ───
      const threatScore = brand.scam_score || 0;
      const verdict =
        threatScore >= 70
          ? "Confirmed Scam"
          : threatScore >= 50
            ? "High Risk"
            : threatScore >= 30
              ? "Suspicious"
              : "Under Review";

      const summary =
        review.summary ||
        `Our intelligence system detected ${brand.total_creatives || 0} unique ad creatives for "${brand.name}" across ${brand.total_geos || 0} countries.`;

      const heroDescription =
        review.headline ||
        summary;

      const wordCount = review.word_count || 0;
      const readingMinutes = Math.max(1, Math.ceil(wordCount / 250));

      const reviewResult = await client.query(
        `INSERT INTO reviews (
           platform_id, slug, status, threat_score, verdict, summary,
           hero_description, warning_callout, investigation_date,
           methodology_text, disclaimer_text, word_count, reading_minutes,
           author, meta_description, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
         ON CONFLICT (slug) DO UPDATE SET
           platform_id = $1, status = $3, threat_score = $4, verdict = $5,
           summary = $6, hero_description = $7, warning_callout = $8,
           investigation_date = $9, methodology_text = $10, disclaimer_text = $11,
           word_count = $12, reading_minutes = $13, author = $14,
           meta_description = $15, updated_at = NOW()
         RETURNING id`,
        [
          platformId,
          slug,
          "published",
          threatScore,
          review.verdict || verdict,
          summary,
          heroDescription,
          `${brand.name} is a ${verdict.toLowerCase()}. Do not deposit any money.`,
          review.published_at || new Date().toISOString(),
          review.methodology || "Investigated using SpyOwl Ad Intelligence surveillance data.",
          review.disclaimer || "This review is based on automated ad surveillance data. All threat scores are algorithmically generated.",
          wordCount,
          readingMinutes,
          "CryptoKiller Research Team",
          review.meta_description || `Is ${brand.name} a scam? Threat score ${threatScore}/100. Read our full investigation.`,
        ]
      );
      const reviewId = reviewResult.rows[0].id;

      // ─── 3. Sync review_stats ───
      const celebrityNames = Array.isArray(brand.celebrity_list)
        ? brand.celebrity_list.join(", ")
        : "";

      await client.query(
        `INSERT INTO review_stats (
           review_id, ad_creatives, countries_targeted, days_active,
           celebrities_abused, weekly_velocity, first_detected,
           last_active, celebrity_names, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (review_id) DO UPDATE SET
           ad_creatives = $2, countries_targeted = $3, days_active = $4,
           celebrities_abused = $5, weekly_velocity = $6, first_detected = $7,
           last_active = $8, celebrity_names = $9`,
        [
          reviewId,
          brand.total_creatives || 0,
          brand.total_geos || 0,
          brand.lifespan_days || 0,
          brand.total_celebrities || 0,
          brand.velocity_7d || 0,
          brand.first_seen_at || null,
          brand.last_seen_at || null,
          celebrityNames,
        ]
      );

      // ─── 4. Sync red_flags ───
      await client.query("DELETE FROM red_flags WHERE review_id = $1", [reviewId]);
      const redFlags = Array.isArray(review.red_flags)
        ? review.red_flags
        : typeof review.red_flags === "string"
          ? JSON.parse(review.red_flags || "[]")
          : [];

      const flagEmojis = ["🚩", "⚠️", "🔒", "⚖️", "⏰", "👤", "📞", "🌍", "💰", "🎭"];
      for (let i = 0; i < redFlags.length; i++) {
        const rf = redFlags[i];
        await client.query(
          `INSERT INTO red_flags (review_id, emoji, title, description, order_index, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            reviewId,
            flagEmojis[i % flagEmojis.length],
            rf.flag || rf.title || `Red Flag ${i + 1}`,
            rf.detail || rf.description || "",
            i,
          ]
        );
      }

      // ─── 5. Sync faq_items ───
      await client.query("DELETE FROM faq_items WHERE review_id = $1", [reviewId]);
      const faqs = Array.isArray(review.faq)
        ? review.faq
        : typeof review.faq === "string"
          ? JSON.parse(review.faq || "[]")
          : [];

      for (let i = 0; i < faqs.length; i++) {
        const faq = faqs[i];
        await client.query(
          `INSERT INTO faq_items (review_id, question, answer, order_index, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [reviewId, faq.question || "", faq.answer || "", i]
        );
      }

      // ─── 6. Sync funnel_stages (from how_it_works) ───
      await client.query("DELETE FROM funnel_stages WHERE review_id = $1", [reviewId]);
      const howItWorks = review.how_it_works || "";
      const stages = howItWorks
        .split(/\n\n+/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);

      const stageLabels = [
        { title: "The Hook", stat: "Social media ads" },
        { title: "The Setup", stat: "Fake platform" },
        { title: "The Deposit", stat: "Crypto wallets" },
        { title: "The Lock", stat: "Blocked withdrawals" },
      ];

      for (let i = 0; i < Math.min(stages.length, 4); i++) {
        await client.query(
          `INSERT INTO funnel_stages (review_id, stage_number, title, description, stat_value, stat_label, bullets, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            reviewId,
            i + 1,
            stageLabels[i]?.title || `Stage ${i + 1}`,
            stages[i],
            String(i + 1),
            stageLabels[i]?.stat || "Step",
            "{}",
          ]
        );
      }

      // ─── 7. Sync geo_targets ───
      await client.query("DELETE FROM geo_targets WHERE review_id = $1", [reviewId]);
      const geoList = Array.isArray(brand.geo_list) ? brand.geo_list : [];

      // Group by rough region
      const regionMap: Record<string, string[]> = {};
      for (const code of geoList) {
        const region = getRegion(code);
        if (!regionMap[region]) regionMap[region] = [];
        regionMap[region].push(code);
      }

      let geoIdx = 0;
      for (const [region, codes] of Object.entries(regionMap)) {
        await client.query(
          `INSERT INTO geo_targets (review_id, region, country_codes, order_index, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [reviewId, region, codes.join(","), geoIdx++]
        );
      }

      // ─── 8. Sync key_findings ───
      await client.query("DELETE FROM key_findings WHERE review_id = $1", [reviewId]);
      const findings = [
        `${brand.total_creatives || 0} fraudulent ad creatives detected across ${brand.total_geos || 0} countries`,
        `Campaign has been active for ${brand.lifespan_days || 0} days with ${brand.velocity_7d || 0} new ads this week`,
        celebrityNames
          ? `Uses fake endorsements from: ${celebrityNames}`
          : "No celebrity endorsements detected",
      ];

      for (let i = 0; i < findings.length; i++) {
        await client.query(
          `INSERT INTO key_findings (review_id, content, order_index, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [reviewId, findings[i], i]
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        review_id: reviewId,
        platform_id: platformId,
        slug,
        synced_tables: [
          "platforms",
          "reviews",
          "review_stats",
          "red_flags",
          "faq_items",
          "funnel_stages",
          "geo_targets",
          "key_findings",
        ],
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error("[sync] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Helper: rough region grouping for geo codes
function getRegion(code: string): string {
  const regions: Record<string, string[]> = {
    "North America": ["US", "CA", "MX"],
    "Europe": ["GB", "DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "SE", "NO", "DK", "FI", "PL", "CZ", "SK", "HU", "RO", "BG", "HR", "SI", "EE", "LV", "LT", "PT", "GR", "IE", "LU", "MT", "CY", "IS", "AL", "BA", "ME", "MK", "RS", "XK", "UA", "BY", "MD"],
    "Asia Pacific": ["AU", "NZ", "JP", "KR", "CN", "HK", "TW", "SG", "MY", "TH", "ID", "PH", "VN", "IN", "BD", "PK", "LK", "NP", "KH", "LA", "MM", "MN", "KZ", "KG", "UZ"],
    "Middle East": ["AE", "SA", "QA", "KW", "BH", "OM", "JO", "LB", "IL", "IR", "IQ", "TR"],
    "Africa": ["ZA", "NG", "KE", "GH", "EG", "MA", "TN", "DZ", "ET", "TZ", "UG", "CM", "SN", "ZW", "ZM", "MZ", "BW", "NA", "RW", "ML", "BF", "BJ", "BJ", "LY", "SD", "MG"],
    "Latin America": ["BR", "AR", "CL", "CO", "PE", "VE", "EC", "UY", "PY", "BO", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "CU", "JM", "BZ"],
  };

  for (const [region, codes] of Object.entries(regions)) {
    if (codes.includes(code.toUpperCase())) return region;
  }
  return "Other";
}

export default router;
