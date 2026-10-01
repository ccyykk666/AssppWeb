import { Router, type Request, type Response } from 'express';
import { readVersionMetadataFromIpa } from '../services/versionMetadata.js';

const router = Router();

router.post('/version-metadata', async (req: Request, res: Response) => {
  const startedAt = performance.now();
  const downloadUrl = req.body?.downloadURL;
  if (typeof downloadUrl !== 'string' || downloadUrl.length > 16_384) {
    res.status(400).json({ error: 'A valid downloadURL is required' });
    return;
  }

  try {
    const metadata = await readVersionMetadataFromIpa(downloadUrl);
    res.setHeader(
      'Server-Timing',
      `ipa-metadata;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    res.json(metadata);
  } catch (error) {
    res.setHeader(
      'Server-Timing',
      `ipa-metadata;dur=${(performance.now() - startedAt).toFixed(1)}`,
    );
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isInvalidUrl =
      message.startsWith('Invalid download URL') ||
      message.startsWith('Download URL');
    console.error('Version metadata lookup failed:', message);
    res.status(isInvalidUrl ? 400 : 502).json({
      error: isInvalidUrl
        ? message
        : 'Unable to read version metadata from the Apple package',
    });
  }
});

export default router;
