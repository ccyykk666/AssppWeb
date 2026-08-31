import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { signSAPAction } = vi.hoisted(() => ({
  signSAPAction: vi.fn(),
}));

vi.mock("../src/services/sapSigner.js", () => ({
  signSAPAction,
}));

import sapRoutes from "../src/routes/sap.js";

describe("SAP signer route", () => {
  const app = express();
  app.use(express.json());
  app.use("/api", sapRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
    signSAPAction.mockResolvedValue("c2lnbmF0dXJl");
  });

  it("returns the signature from the private signer", async () => {
    const body = {
      guid: "AABBCCDDEEFF",
      setupURL: "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
      certificateURL: "https://s.mzstatic.com/sap/setupCert.plist",
      version: 200,
      body: "PHBsaXN0Lz4=",
    };

    const response = await request(app).post("/api/sap/sign").send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ signature: "c2lnbmF0dXJl" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(signSAPAction).toHaveBeenCalledWith(body);
  });

  it("rejects malformed input before calling the signer", async () => {
    const response = await request(app)
      .post("/api/sap/sign")
      .send({ guid: "AABBCCDDEEFF" });

    expect(response.status).toBe(400);
    expect(signSAPAction).not.toHaveBeenCalled();
  });

  it("does not expose signer failure details", async () => {
    signSAPAction.mockRejectedValue(new Error("private detail"));

    const response = await request(app).post("/api/sap/sign").send({
      guid: "AABBCCDDEEFF",
      setupURL: "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
      certificateURL: "https://s.mzstatic.com/sap/setupCert.plist",
      version: 200,
      body: "PHBsaXN0Lz4=",
    });

    expect(response.status).toBe(503);
    expect(response.text).not.toContain("private detail");
  });
});
