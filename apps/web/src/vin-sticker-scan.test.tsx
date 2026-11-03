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

  it("scan comes first; the how-to graphics hide behind a plain link", () => {
    render(<PublicIntakePage />);
    // The Start button is right there; no instruction cards in the way.
    expect(
      screen.getByRole("button", { name: /start camera scan/i })
    ).toBeInTheDocument();
    // Mounting the scan UI warms the vPIC connection (DNS + TLS), so
    // the car lookup after a decode isn't stuck behind a cold start.
    expect(
      document.head.querySelector(
        'link[rel="preconnect"][href="https://vpic.nhtsa.dot.gov"]'
      )
    ).not.toBeNull();
    expect(
      screen.queryByRole("img", { name: /sticker highlighted on the door frame/i })
    ).not.toBeInTheDocument();
    // One tap on the link and both graphics show.
    fireEvent.click(screen.getByRole("button", { name: /where.s the sticker/i }));
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
    scanPhoto();

    // The decode proposes a candidate — the form is untouched so far.
    // (Scoped to the <strong>: the sticker diagram also prints this VIN.)
    expect(await screen.findByText(/Found VIN:/)).toBeInTheDocument();
    expect(screen.getByText(VALID_VIN, { selector: "strong" })).toBeInTheDocument();
    // No tabs anymore: the VIN field is always on the card, still empty.
    expect(vinInput().value).toBe("");
    expect(continueButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Use this VIN" }));

    // Confirmed: the VIN fills the field in place — it behaves
    // exactly like a typed one, the customer is still on card 1,
    // and nothing fired.
    expect(vinInput().value).toBe(VALID_VIN);
    expect(screen.queryByText(/Found VIN:/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your vehicle" })).toBeInTheDocument();
    expect(continueButton().disabled).toBe(false);
    // Nothing submits: the only network call a scan may make before
    // Send is the free NHTSA lookup — never our own API.
    expect(
      fetchMock.mock.calls.every(c =>
        String(c[0]).includes("vpic.nhtsa.dot.gov")
      )
    ).toBe(true);
  });

  it("Scan again discards the candidate without filling the VIN", async () => {
    decodeMock.mockResolvedValue({ text: VALID_VIN, format: "Code39" });
    render(<PublicIntakePage />);
    scanPhoto();
    expect(await screen.findByText(/Found VIN:/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(screen.queryByText(/Found VIN:/)).not.toBeInTheDocument();
    expect(vinInput().value).toBe("");
    expect(continueButton().disabled).toBe(true);
  });

  it("a found VIN is looked up and the car is named for confirmation", async () => {
    decodeMock.mockResolvedValue({
      text: `MFD BY FCA VIN ${VALID_VIN} END`,
      format: "QRCode"
    });
    fetchMock.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).includes("vpic.nhtsa.dot.gov")
        ? {
            ok: true,
            json: async () => ({
              Results: [
                {
                  ModelYear: "2018",
                  Make: "JEEP",
                  Model: "Wrangler Unlimited",
                  Trim: "Sahara",
                  ErrorCode: "0"
                }
              ]
            })
          }
        : { ok: true, json: async () => ({}) }
    );
    render(<PublicIntakePage />);
    scanPhoto();

    // The confirmation names the car and asks the only question the
    // customer can answer at a glance.
    expect(
      await screen.findByText(/2018 JEEP Wrangler Unlimited Sahara/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Is this your car\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use this VIN" }));
    expect(vinInput().value).toBe(VALID_VIN);
    expect(continueButton().disabled).toBe(false);
  });

  it("when the lookup can't name the car, the card falls back to checking the sticker", async () => {
    decodeMock.mockResolvedValue({ text: VALID_VIN, format: "Code39" });
    render(<PublicIntakePage />);
    scanPhoto();
    // Default fetch stub answers {} — no Results, no car name.
    expect(
      await screen.findByText(/couldn't look this VIN up/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Found VIN:/)).toBeInTheDocument();
    // The VIN is still usable — the lookup never gates the form.
    fireEvent.click(screen.getByRole("button", { name: "Use this VIN" }));
    expect(vinInput().value).toBe(VALID_VIN);
  });

  it("a decoded VIN whose check digit fails is rejected with an explanation, never offered", async () => {
    decodeMock.mockResolvedValue({ text: BAD_CHECK_VIN, format: "Code39" });
    render(<PublicIntakePage />);
    scanPhoto();
    expect(await screen.findByText(/didn't pass the VIN check/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(BAD_CHECK_VIN))).toBeInTheDocument();
    expect(screen.queryByText(/Found VIN:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this VIN" })).not.toBeInTheDocument();
    expect(vinInput().value).toBe("");
    expect(continueButton().disabled).toBe(true);
  });

  it("a code with no VIN in it says so and fills nothing", async () => {
    decodeMock.mockResolvedValue({ text: "https://example.com/promo", format: "QRCode" });
    render(<PublicIntakePage />);
    scanPhoto();
    expect(await screen.findByText(/doesn't contain a VIN/)).toBeInTheDocument();
    expect(vinInput().value).toBe("");
  });

  it("no code in the photo says so and fills nothing", async () => {
    decodeMock.mockResolvedValue(null);
    render(<PublicIntakePage />);
    scanPhoto();
    expect(await screen.findByText(/No barcode or QR code found/)).toBeInTheDocument();
    expect(vinInput().value).toBe("");
  });

  it("a camera preview that refuses to play says so instead of scanning forever", async () => {
    // The 2026-10-30 field failure: on iOS the preview never
    // started and the swallowed play() rejection left the panel on
    // "Scanning…" with no way forward. Now the refusal surfaces.
    const { trackStop } = stubCamera(() =>
      Promise.reject(new Error("NotAllowedError"))
    );
    render(<PublicIntakePage />);
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
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(await screen.findByText(/Scanning…/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stop camera/i }));
    expect(screen.queryByText(/Scanning…/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start camera scan/i })
    ).toBeInTheDocument();
  });

  it("card 1 has no tab bar — scan actions lead and the VIN field sits under them", () => {
    render(<PublicIntakePage />);
    // The [Scan | Type] tabs are gone for good: neither tab button
    // exists, on any device.
    expect(
      screen.queryByRole("button", { name: /scan the sticker/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /type the vin/i })
    ).not.toBeInTheDocument();
    // Scan leads the card, the field follows it in the layout, and
    // the how-to graphics still hide behind their link.
    const start = screen.getByRole("button", { name: /start camera scan/i });
    expect(
      start.compareDocumentPosition(vinInput()) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.queryByRole("img", { name: /sticker highlighted on the door frame/i })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /where.s the sticker/i }));
    expect(
      screen.getByRole("img", { name: /sticker highlighted on the door frame/i })
    ).toBeInTheDocument();
  });

  it("the live preview gets a viewfinder frame to fit the code into", async () => {
    stubCamera(() => Promise.resolve());
    render(<PublicIntakePage />);
    // No frame until the camera is actually live.
    expect(
      screen.queryByText(/fit the barcode or qr code inside the frame/i)
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(await screen.findByText(/Scanning…/)).toBeInTheDocument();
    expect(
      screen.getByText(/fit the barcode or qr code inside the frame/i)
    ).toBeInTheDocument();
    // …and Stop still works with the frame up.
    fireEvent.click(screen.getByRole("button", { name: /stop camera/i }));
    expect(
      screen.queryByText(/fit the barcode or qr code inside the frame/i)
    ).not.toBeInTheDocument();
  });

  it("a typed VIN survives the camera opening and closing, and a failed scan attempt", async () => {
    stubCamera(() => Promise.resolve());
    render(<PublicIntakePage />);
    fireEvent.change(vinInput(), { target: { value: "1C4H" } });
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(await screen.findByText(/Scanning…/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stop camera/i }));
    expect(vinInput().value).toBe("1C4H");
    // A photo attempt that finds nothing must not clear typing either.
    decodeMock.mockResolvedValue(null);
    scanPhoto();
    expect(
      await screen.findByText(/No barcode or QR code found/)
    ).toBeInTheDocument();
    expect(vinInput().value).toBe("1C4H");
  });

  it("a touch device with a camera gets the same stacked card — no dead tab to tap", () => {
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
    // This is the layout that read as broken on Nelly's phone: the
    // active tab looked like a button and did nothing. Now there is
    // no tab — the Start button and the field are both just there.
    expect(
      screen.queryByRole("button", { name: /scan the sticker/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start camera scan/i })
    ).toBeInTheDocument();
    expect(vinInput()).toBeInTheDocument();
  });

  it("without a camera the panel points at the photo option instead of dying", async () => {
    render(<PublicIntakePage />);
    fireEvent.click(screen.getByRole("button", { name: /start camera scan/i }));
    expect(await screen.findByText(/Camera isn't available here/)).toBeInTheDocument();
  });
});
