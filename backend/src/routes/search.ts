import { Router, Request, Response } from "express";

const router = Router();

// Map iTunes API fields to our Software type, matching Swift CodingKeys
function mapSoftware(item: Record<string, any>) {
  return {
    id: item.trackId,
    bundleID: item.bundleId,
    name: item.trackName,
    version: item.version,
    price: item.price,
    artistName: item.artistName,
    sellerName: item.sellerName,
    description: item.description,
    averageUserRating: item.averageUserRating,
    userRatingCount: item.userRatingCount,
    artworkUrl: item.artworkUrl512,
    screenshotUrls: item.screenshotUrls ?? [],
    minimumOsVersion: item.minimumOsVersion,
    fileSizeBytes: item.fileSizeBytes,
    releaseDate: item.currentVersionReleaseDate ?? item.releaseDate,
    releaseNotes: item.releaseNotes,
    formattedPrice: item.formattedPrice,
    primaryGenreName: item.primaryGenreName,
    primaryGenreId: item.primaryGenreId,
  };
}

router.get("/search", async (req: Request, res: Response) => {
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(
      `https://itunes.apple.com/search?${params.toString()}`,
    );
    const data = await response.json();
    const results = (data.results ?? []).map(mapSoftware);
    res.json(results);
  } catch (err) {
    console.error("Search error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Search request failed" });
  }
});

router.get("/lookup", async (req: Request, res: Response) => {
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(
      `https://itunes.apple.com/lookup?${params.toString()}`,
    );
    const data = await response.json();
    if (!data.resultCount || !data.results?.length) {
      res.json(null);
      return;
    }
    res.json(mapSoftware(data.results[0]));
  } catch (err) {
    console.error("Lookup error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Lookup request failed" });
  }
});

// Public catalog metadata only: no Apple credentials or cookies are needed.
router.get('/catalog-version', async (req: Request, res: Response) => {
  const { id, country } = req.query;
  if (typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) ||
    typeof country !== 'string' || !/^[a-z]{2}$/i.test(country)) {
    res.status(400).json({ error: 'Invalid app ID or country' });
    return;
  }
  try {
    const params = new URLSearchParams({
      version: '2', id, p: 'mdm-lockup', caller: 'MDM',
      platform: 'enterprisestore', cc: country.toLowerCase(), l: 'en',
    });
    const response = await fetch(
      `https://uclient-api.itunes.apple.com/WebObjects/MZStorePlatform.woa/wa/lookup?${params}`,
      { signal: AbortSignal.timeout(15000), redirect: 'error' },
    );
    if (!response.ok) throw new Error('Catalog HTTP error');
    const data = await response.json();
    const item = data.results?.[id];
    const offer = item?.offers?.[0];
    const externalVersionId = String(offer?.version?.externalId ??
      new URLSearchParams(offer?.buyParams ?? '').get('appExtVrsId') ?? '');
    if (!item || typeof item.bundleId !== 'string' || !item.bundleId ||
      !/^[1-9]\d*$/.test(externalVersionId)) {
      res.json(null);
      return;
    }
    res.json({ externalVersionId, version: offer?.version?.display ?? '', bundleID: item.bundleId });
  } catch {
    res.status(502).json({ error: 'Latest Apple catalog version lookup failed' });
  }
});

export default router;
