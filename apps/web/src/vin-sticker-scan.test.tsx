import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicIntakePage } from "./App";
import { decodeStickerCode, extractVinFromStickerText } from "./vin-scan";

// The decoder itself is proven against the bundled wasm in the built
// app (and by the standalone prototype's real-car test); here only the
// reader is stubbed so the intake flow around it can be tested. The
// pure extraction helper stays real via importActual.
vi.mock("./vin-scan", async importOriginal => {
  const actual = await importOriginal<typeof import("./vin-scan")>();
  return { ...actual, decodeStickerCode: vi.fn() };
});

const decodeMock = vi.mocked(decodeStickerCode);

const VALID_VIN = "1C4HJXEG3JW224862"; // the prototype's sample Wrangler VIN
const BAD_CHECK_VIN = "1C4HJXEG3JW224863"; // same VIN, last digit bumped — check digit fails

describe("extractVinFromStickerText", () => {
  it("pulls the VIN out of a wrapped QR payload", () => {
    expect(extractVinFromStickerText(`CERT LABEL ${VALID_VIN} GVWR 2400`)).toBe(VALID_VIN);
    expect(extractVinFromStickerText(VALID_VIN.toLowerCase())).toBe(VALID_VIN);
  });

  it("finds the VIN glued inside a longer alphanumeric payload", () => {
    // Cleaning glues the fields into one string; the first 17 chars
    // are junk that fits the VIN alphabet, so only the check digit
    // can pick the real window out.
    expect(extractVinFromStickerText(`CERTLABEL${VALID_VIN}GVWR2400`)).toBe(VALID_VIN);
  });

  it("returns a standalone 17-char read as-is so its check-digit failure can be reported", () => {
    expect(extractVinFromStickerText(BAD_CHECK_VIN)).toBe(BAD_CHECK_VIN);
  });

  it("returns null when the text holds no 17-character VIN", () => {
    expect(extractVinFromStickerText("HELLO WORLD")).toBeNull();
    expect(extractVinFromStickerText("")).toBeNull();
  });
});

describe("public intake door-sticker scan (card 1)", () => {
  afterEach(() => cleanup());

  afterEach(() => {
    // Undo any camera stubs a test installed.
    vi.restoreAllMocks();
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: undefined,
      configurable: true
    });
    (window as { matchMedia?: unknown }).matchMedia = undefined;
  });

  function stubCamera(playImpl: () => Promise<void>) {
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] };
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn(async () => stream) },
      configurable: true
    });
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(playImpl);
    return { trackStop };
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    decodeMock.mockReset();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
  });

  function openScanner() {
    // Card 1 is tabbed now: the Scan tab IS the scanner.
    fireEvent.click(screen.getByRole("button", { name: /scan the sticker/i }));
  }

  function scanPhoto() {
    const photo = new File(["sticker-bytes"], "sticker.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/use a photo of the sticker/i), {
      target: { files: [photo] }
    });
  }

  function vinInput() {
    return screen.getByLabelText(/^VIN/) as HTMLInputElement;
  }

  function continueButton() {
    return screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
  }

  it("shows the two instruction graphics when the scanner opens", () => {
    render(<PublicIntakePage />);
    openScanner();
    expect(
      screen.getByRole("img", { name: /sticker highlighted on the door frame/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /close-up of the certification sticker/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/no photo is uploaded or saved/i)).toBeInTheDocument();
  });

  it("decode proposes, the customer confirms, and only then the VIN fills — nothing submits", async () => {
    decodeMock.mockResolvedValue({
      text: `MFD BY FCA VIN ${VALID_VIN} END`,
      format: "QRCode"
    });
    render(<PublicIntakePage />);
    openScanner();
    scanPhoto();

    // The decode proposes a candidate — the form is untouched so far.
    // (Scoped to the <strong>: the sticker diagram also prints this VIN.)
    expect(await screen.findByText(/Found VIN:/)).toBeInTheDocument();
    expect(screen.getByText(VALID_VIN, { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^VIN/)).not.toBeInTheDocument();
    expect(continueButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Use this VIN" }));

    // Confirmed: the customer lands on the Type tab with the VIN in
    // the field — it behaves exactly like a typed one, the scanner
    // is gone, the customer is still on card 1, and nothing fired.
    expect(
      screen.queryByRole("img", { name: /sticker highlighted on the door frame/i })
    ).not.toBeInTheDocument();
    expect(vinInput().value).toBe(VALID_VIN);
    expect(screen.queryByText(/Found VIN:/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your vehicle" })).toBeInTheDocument();
    expect(continueButton().disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Retake discards the candidate without filling the VIN", async () => {
    decodeMock.mockResolvedValue({ text: VALID_VIN, format: "Code39" });
    render(<PublicIntakePage />);
    openScanner();
    scanPhoto();
    expect(await screen.findByText(/Found VIN:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retake" }));
    expect(screen.queryByText(/Found VIN:/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^VIN/)).not.toBeInTheDocument();
    expect(continueButton().disabled).toBe(true);
  });

  it("a decoded VIN whose check digit fails is rejected with an explanation, never offered", async () => {
    decodeMock.mockResolvedValue({ text: BAD_CHECK_VIN, format: "Code39" });
    render(<PublicIntakePage />);
    openScanner();
    scanPhoto();
    expect(await screen.findByText(/didn't pass the VIN check/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(BAD_CHECK_VIN))).toBeInTheDocument();
    expect(screen.queryByText(/Found VIN:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this VIN" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^VIN/)).not.toBeInTheDocument();
    expect(continueButton().disabled).toBe(true);
  });

  it("a code with no VIN in it says so and fills nothing", async () => {
    decodeMock.mockResolvedValue({ text: "https://example.com/promo", format: "QRCode" });
    render(<PublicIntakePage />);
    openScanner();
    scanPhoto();
    expect(await screen.findByText(/doesn't contain a VIN/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^VIN/)).not.toBeInTheDocument();
  });

  it("no code in the photo says so and fills nothing", async () => {
    decodeMock.mockResolvedValue(null);
    render(<PublicIntakePage />);
    openScanner();
    scanPhoto();
    expect(await screen.findByText(/No barcode or QR code found/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^VIN/)).not.toBeInTheDocument();
  });

  it("a camera preview that refuses to play says so instead of scanning forever", async () => {
    // The 2026-10-30 field failure: on iOS the preview never
    // started and the swallowed play() rejection left the panel on
    // "Scanning…" with no way forward. Now the refusal surfaces.
    const { trackStop } = stubCamera(() =>
      Promise.reject(new Error("NotAllowedError"))
    );
    render(<PublicIntakePage />);
    openScanner();
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(
      await screen.findByText(/camera preview couldn't start/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Scanning…/)).not.toBeInTheDocument();
    // The stream was torn down and the start button is back.
    expect(trackStop).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /start camera scan/i })
    ).toBeInTheDocument();
  });

  it("stopping the camera clears the Scanning status", async () => {
    stubCamera(() => Promise.resolve());
    render(<PublicIntakePage />);
    openScanner();
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(await screen.findByText(/Scanning…/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stop camera/i }));
    expect(screen.queryByText(/Scanning…/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start camera scan/i })
    ).toBeInTheDocument();
  });

  it("card 1 opens on Type by default; Scan is one tap away and back", () => {
    render(<PublicIntakePage />);
    // Desktop default: the VIN field, no scanner graphics yet.
    expect(vinInput()).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /sticker highlighted on the door frame/i })
    ).not.toBeInTheDocument();
    openScanner();
    expect(
      screen.getByRole("img", { name: /sticker highlighted on the door frame/i })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /type the vin/i }));
    expect(vinInput()).toBeInTheDocument();
  });

  it("switching tabs never loses a typed VIN", () => {
    render(<PublicIntakePage />);
    fireEvent.change(vinInput(), { target: { value: "1C4H" } });
    openScanner();
    fireEvent.click(screen.getByRole("button", { name: /type the vin/i }));
    expect(vinInput().value).toBe("1C4H");
  });

  it("a touch device with a camera opens on the Scan tab", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("coarse"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as typeof window.matchMedia;
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn() },
      configurable: true
    });
    render(<PublicIntakePage />);
    // No tap needed: the graphics (hence the Scan tab) are already up.
    expect(
      screen.getByRole("img", { name: /sticker highlighted on the door frame/i })
    ).toBeInTheDocument();
  });

  it("without a camera the panel points at the photo option instead of dying", async () => {
    render(<PublicIntakePage />);
    openScanner();
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(await screen.findByText(/Camera isn't available here/)).toBeInTheDocument();
  });
});
