/**
 * Instruction graphics for the door-sticker VIN scan, ported from the
 * standalone prototype Nelly approved (2026-10-29): (1) where the
 * sticker lives — on the frame the driver's door closes against, only
 * visible with the door open; (2) what it looks like up close — the VIN
 * line with a barcode (most cars) and a QR code (newer cars). Inline
 * SVG: no image assets, no network fetch.
 */
export function DoorJambGraphic() {
  return (
    <svg viewBox="0 0 340 170" role="img" aria-label="Diagram: open driver door, sticker highlighted on the door frame">
  <polygon points="28,28 116,42 116,148 28,162" fill="#24405c" stroke="#6fa8dc" strokeWidth="2"/>
  <polygon points="42,42 102,52 102,90 42,96" fill="#9fc3e8" opacity="0.45"/>
  <rect x="90" y="106" width="17" height="5" rx="2.5" fill="#6fa8dc"/>
  <rect x="140" y="16" width="184" height="142" rx="14" fill="#10161d" stroke="#4a6a8a" strokeWidth="3"/>
  <rect x="152" y="28" width="160" height="118" rx="10" fill="#05080b"/>
  <path d="M168 146 L168 110 Q168 101 177 101 L195 101 Q204 101 204 110 L204 146 Z" fill="#22303f"/>
  <rect x="160" y="130" width="72" height="13" rx="5" fill="#22303f"/>
  <rect x="284" y="28" width="28" height="118" fill="#16222e"/>
  <rect x="291" y="54" width="15" height="48" rx="2" fill="#e8edf2"/>
  <rect x="294" y="59" width="9" height="2.5" fill="#12222e"/><rect x="294" y="64" width="9" height="2.5" fill="#12222e"/>
  <rect x="294" y="70" width="9" height="14" fill="#12222e" opacity="0.85"/>
  <rect x="294" y="87" width="9" height="9" fill="#fff" stroke="#12222e"/>
  <circle cx="298" cy="78" r="25" fill="none" stroke="#ffd479" strokeWidth="3"/>
  <circle cx="298" cy="78" r="3" fill="#ffd479"/>
</svg>
  );
}

export function StickerGraphic() {
  return (
    <svg viewBox="0 0 340 176" role="img" aria-label="Diagram: close-up of the certification sticker showing the VIN, a barcode and a QR code">
  <path d="M14 32 L14 14 L32 14" fill="none" stroke="#ffd479" strokeWidth="3"/>
  <path d="M308 14 L326 14 L326 32" fill="none" stroke="#ffd479" strokeWidth="3"/>
  <path d="M326 144 L326 162 L308 162" fill="none" stroke="#ffd479" strokeWidth="3"/>
  <path d="M32 162 L14 162 L14 144" fill="none" stroke="#ffd479" strokeWidth="3"/>
  <rect x="34" y="20" width="272" height="136" rx="8" fill="#e8edf2"/>
  <text x="48" y="42" fontSize="11" fontWeight="700" fill="#33424f" letterSpacing="1">VEHICLE CERTIFICATION</text>
  <rect x="48" y="52" width="110" height="5" fill="#b9c6d2"/><rect x="48" y="62" width="88" height="5" fill="#b9c6d2"/>
  <rect x="176" y="52" width="72" height="5" fill="#b9c6d2"/><rect x="176" y="62" width="58" height="5" fill="#b9c6d2"/>
  <text x="48" y="89" fontSize="12" fontWeight="700" fill="#12222e">VIN</text>
  <text x="80" y="89" fontFamily="ui-monospace, Menlo, monospace" fontSize="13.5" fill="#12222e">1C4HJXEG3JW224862</text>
  <rect x="48" y="96" width="3" height="34" fill="#12222e"/><rect x="53" y="96" width="1" height="34" fill="#12222e"/><rect x="56" y="96" width="2" height="34" fill="#12222e"/><rect x="60" y="96" width="1" height="34" fill="#12222e"/><rect x="63" y="96" width="1" height="34" fill="#12222e"/><rect x="66" y="96" width="3" height="34" fill="#12222e"/><rect x="71" y="96" width="2" height="34" fill="#12222e"/><rect x="75" y="96" width="2" height="34" fill="#12222e"/><rect x="79" y="96" width="1" height="34" fill="#12222e"/><rect x="82" y="96" width="1" height="34" fill="#12222e"/><rect x="85" y="96" width="3" height="34" fill="#12222e"/><rect x="90" y="96" width="1" height="34" fill="#12222e"/><rect x="93" y="96" width="2" height="34" fill="#12222e"/><rect x="97" y="96" width="1" height="34" fill="#12222e"/><rect x="100" y="96" width="1" height="34" fill="#12222e"/><rect x="103" y="96" width="2" height="34" fill="#12222e"/><rect x="107" y="96" width="3" height="34" fill="#12222e"/><rect x="112" y="96" width="1" height="34" fill="#12222e"/><rect x="115" y="96" width="2" height="34" fill="#12222e"/><rect x="119" y="96" width="1" height="34" fill="#12222e"/><rect x="122" y="96" width="1" height="34" fill="#12222e"/><rect x="125" y="96" width="3" height="34" fill="#12222e"/><rect x="130" y="96" width="1" height="34" fill="#12222e"/><rect x="133" y="96" width="2" height="34" fill="#12222e"/><rect x="137" y="96" width="3" height="34" fill="#12222e"/><rect x="142" y="96" width="1" height="34" fill="#12222e"/><rect x="145" y="96" width="2" height="34" fill="#12222e"/><rect x="149" y="96" width="1" height="34" fill="#12222e"/><rect x="152" y="96" width="1" height="34" fill="#12222e"/><rect x="155" y="96" width="3" height="34" fill="#12222e"/><rect x="160" y="96" width="2" height="34" fill="#12222e"/><rect x="164" y="96" width="2" height="34" fill="#12222e"/><rect x="168" y="96" width="1" height="34" fill="#12222e"/><rect x="171" y="96" width="1" height="34" fill="#12222e"/><rect x="174" y="96" width="3" height="34" fill="#12222e"/><rect x="179" y="96" width="1" height="34" fill="#12222e"/><rect x="182" y="96" width="2" height="34" fill="#12222e"/><rect x="186" y="96" width="1" height="34" fill="#12222e"/><rect x="189" y="96" width="1" height="34" fill="#12222e"/><rect x="192" y="96" width="2" height="34" fill="#12222e"/><rect x="196" y="96" width="3" height="34" fill="#12222e"/>
  <rect x="222" y="92" width="52" height="52" fill="#fff" stroke="#12222e" strokeWidth="1.5"/><rect x="224" y="94" width="12" height="12" fill="#12222e"/><rect x="226" y="96" width="8" height="8" fill="#fff"/><rect x="228" y="98" width="4" height="4" fill="#12222e"/><rect x="258" y="94" width="12" height="12" fill="#12222e"/><rect x="260" y="96" width="8" height="8" fill="#fff"/><rect x="262" y="98" width="4" height="4" fill="#12222e"/><rect x="224" y="128" width="12" height="12" fill="#12222e"/><rect x="226" y="130" width="8" height="8" fill="#fff"/><rect x="228" y="132" width="4" height="4" fill="#12222e"/><rect x="244" y="98" width="4" height="4" fill="#12222e"/><rect x="240" y="102" width="4" height="4" fill="#12222e"/><rect x="244" y="102" width="4" height="4" fill="#12222e"/><rect x="248" y="102" width="4" height="4" fill="#12222e"/><rect x="240" y="106" width="4" height="4" fill="#12222e"/><rect x="224" y="110" width="4" height="4" fill="#12222e"/><rect x="228" y="110" width="4" height="4" fill="#12222e"/><rect x="236" y="110" width="4" height="4" fill="#12222e"/><rect x="240" y="110" width="4" height="4" fill="#12222e"/><rect x="244" y="110" width="4" height="4" fill="#12222e"/><rect x="248" y="110" width="4" height="4" fill="#12222e"/><rect x="232" y="114" width="4" height="4" fill="#12222e"/><rect x="252" y="114" width="4" height="4" fill="#12222e"/><rect x="256" y="114" width="4" height="4" fill="#12222e"/><rect x="260" y="114" width="4" height="4" fill="#12222e"/><rect x="264" y="114" width="4" height="4" fill="#12222e"/><rect x="272" y="114" width="4" height="4" fill="#12222e"/><rect x="228" y="118" width="4" height="4" fill="#12222e"/><rect x="240" y="118" width="4" height="4" fill="#12222e"/><rect x="244" y="118" width="4" height="4" fill="#12222e"/><rect x="260" y="118" width="4" height="4" fill="#12222e"/><rect x="264" y="118" width="4" height="4" fill="#12222e"/><rect x="224" y="122" width="4" height="4" fill="#12222e"/><rect x="228" y="122" width="4" height="4" fill="#12222e"/><rect x="232" y="122" width="4" height="4" fill="#12222e"/><rect x="244" y="122" width="4" height="4" fill="#12222e"/><rect x="248" y="122" width="4" height="4" fill="#12222e"/><rect x="252" y="122" width="4" height="4" fill="#12222e"/><rect x="256" y="122" width="4" height="4" fill="#12222e"/><rect x="264" y="122" width="4" height="4" fill="#12222e"/><rect x="224" y="126" width="4" height="4" fill="#12222e"/><rect x="232" y="126" width="4" height="4" fill="#12222e"/><rect x="240" y="126" width="4" height="4" fill="#12222e"/><rect x="248" y="126" width="4" height="4" fill="#12222e"/><rect x="252" y="126" width="4" height="4" fill="#12222e"/><rect x="264" y="126" width="4" height="4" fill="#12222e"/><rect x="272" y="126" width="4" height="4" fill="#12222e"/><rect x="240" y="130" width="4" height="4" fill="#12222e"/><rect x="252" y="130" width="4" height="4" fill="#12222e"/><rect x="260" y="130" width="4" height="4" fill="#12222e"/><rect x="264" y="130" width="4" height="4" fill="#12222e"/><rect x="272" y="130" width="4" height="4" fill="#12222e"/><rect x="240" y="134" width="4" height="4" fill="#12222e"/><rect x="244" y="134" width="4" height="4" fill="#12222e"/><rect x="248" y="134" width="4" height="4" fill="#12222e"/><rect x="256" y="134" width="4" height="4" fill="#12222e"/><rect x="264" y="134" width="4" height="4" fill="#12222e"/><rect x="252" y="138" width="4" height="4" fill="#12222e"/><rect x="256" y="138" width="4" height="4" fill="#12222e"/><rect x="268" y="138" width="4" height="4" fill="#12222e"/><rect x="272" y="138" width="4" height="4" fill="#12222e"/><rect x="248" y="142" width="4" height="4" fill="#12222e"/><rect x="268" y="142" width="4" height="4" fill="#12222e"/><rect x="272" y="142" width="4" height="4" fill="#12222e"/>
  <text x="48" y="146" fontSize="9.5" fill="#5a6b7a">BARCODE — most cars</text>
  <text x="222" y="152" fontSize="9.5" fill="#5a6b7a">QR — newer cars</text>
</svg>
  );
}
