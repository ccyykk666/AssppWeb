import { Router, type Request, type Response } from "express";
import { signSAPAction, type SAPSignInput } from "../services/sapSigner.js";

const router = Router();
const MAX_ENCODED_BODY_LENGTH = 96 * 1024;

function validSignInput(value: unknown): value is SAPSignInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    typeof input.guid === "string" &&
    input.guid.length <= 128 &&
    typeof input.setupURL === "string" &&
    input.setupURL.length <= 2048 &&
    typeof input.certificateURL === "string" &&
    input.certificateURL.length <= 2048 &&
    typeof input.version === "number" &&
    Number.isInteger(input.version) &&
    typeof input.body === "string" &&
    input.body.length > 0 &&
    input.body.length <= MAX_ENCODED_BODY_LENGTH
  );
}

router.post("/sap/sign", async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  if (!validSignInput(req.body)) {
    res.status(400).json({ error: "Invalid SAP sign request" });
    return;
  }

  try {
    const signature = await signSAPAction(req.body);
    res.json({ signature });
  } catch {
    console.error("SAP signer request failed");
    res.status(503).json({ error: "SAP signer unavailable" });
  }
});

export default router;
