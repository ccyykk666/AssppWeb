package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/majd/ipatool/v2/internal/sap"
)

type stubSigner struct {
	input []byte
}

func (s *stubSigner) Sign(input []byte) ([]byte, error) {
	s.input = append([]byte(nil), input...)
	return []byte("signed"), nil
}

func (*stubSigner) Close() error {
	return nil
}

func validRequest(body []byte) signRequest {
	return signRequest{
		GUID:           "aa:bb:cc:dd:ee:ff",
		SetupURL:       "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy",
		CertificateURL: "https://s.mzstatic.com/sap/setupCert.plist",
		Version:        200,
		Body:           base64.StdEncoding.EncodeToString(body),
	}
}

func TestParseGUID(t *testing.T) {
	normalized, hardware, err := parseGUID("aa:bb-CC dd-ee-ff")
	if err != nil {
		t.Fatal(err)
	}
	if normalized != "AABBCCDDEEFF" {
		t.Fatalf("normalized GUID = %q", normalized)
	}
	if got := base64.StdEncoding.EncodeToString(hardware); got != "qrvM3e7/" {
		t.Fatalf("hardware bytes = %q", got)
	}
}

func TestValidatedSignInputRejectsNonAppleEndpoint(t *testing.T) {
	request := validRequest([]byte("payload"))
	request.SetupURL = "https://example.com/v1/signSapSetup/legacy"
	if _, _, _, err := validatedSignInput(request); err == nil {
		t.Fatal("validatedSignInput accepted a non-Apple setup URL")
	}
}

func TestHandlerSignsExactBody(t *testing.T) {
	stub := &stubSigner{}
	manager := newSignerManager(func(context.Context, sap.Config) (sap.ActionSigner, error) {
		return stub, nil
	})
	defer manager.close()

	payload := []byte("<plist>密码</plist>")
	encoded, err := json.Marshal(validRequest(payload))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/sign", bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer 01234567890123456789012345678901")
	recorder := httptest.NewRecorder()

	handler(manager, "01234567890123456789012345678901").ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !bytes.Equal(stub.input, payload) {
		t.Fatalf("signed payload = %q", stub.input)
	}

	var response signResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Signature != base64.StdEncoding.EncodeToString([]byte("signed")) {
		t.Fatalf("signature = %q", response.Signature)
	}
}

func TestHandlerRequiresInternalToken(t *testing.T) {
	manager := newSignerManager(func(context.Context, sap.Config) (sap.ActionSigner, error) {
		t.Fatal("signer factory should not be called")
		return nil, nil
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/sign", bytes.NewReader([]byte("{}")))
	recorder := httptest.NewRecorder()

	handler(manager, "01234567890123456789012345678901").ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
}
