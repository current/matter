export type LoopbackAuthorizationStage = "dev" | "nightly" | "latest";

declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;

function resolveLoopbackAuthorizationStage(): LoopbackAuthorizationStage {
  return typeof __T3CODE_BUILD_CHANNEL__ === "undefined" ? "dev" : __T3CODE_BUILD_CHANNEL__;
}

const stageBrands = {
  dev: "mattr (Dev)",
  nightly: "mattr (Nightly)",
  latest: "mattr",
} as const satisfies Record<LoopbackAuthorizationStage, string>;

const MATTR_FAVICON_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#f5f5f7"/><g transform="translate(27,16) scale(0.088)" fill="#111"><g transform="translate(0,1648) scale(0.1,-0.1)"><path d="M9000 16274 c-397 -80 -671 -317 -800 -694 -37 -110 -51 -302 -32 -445 85 -625 759 -1010 1352 -771 320 129 568 436 612 758 38 286 -23 542 -179 754 -138 186 -333 316 -568 380 -59 16 -331 28 -385 18z M4120 15353 c-349 -38 -644 -288 -751 -636 -91 -293 -4 -635 217 -861 239 -243 568 -324 904 -222 298 91 542 367 596 677 102 585 -380 1106 -966 1042z M12520 14154 c-481 -65 -828 -340 -1008 -799 -60 -154 -76 -442 -35 -630 97 -440 433 -786 869 -895 139 -35 388 -43 516 -15 477 101 832 458 928 932 30 145 25 379 -9 511 -117 448 -480 791 -928 877 -82 16 -273 26 -333 19z M9168 14134 c-286 -52 -503 -259 -730 -699 -271 -522 -457 -666 -998 -771 -239 -47 -642 -41 -1090 16 -265 33 -443 68 -667 131 -237 67 -283 92 -575 310 -235 175 -371 233 -553 233 -428 0 -790 -280 -939 -727 -120 -358 -101 -714 64 -1192 265 -772 708 -1343 982 -1267 153 42 468 402 623 711 36 72 224 385 266 444 243 337 460 539 702 652 119 56 362 126 587 170 47 9 117 23 155 31 247 50 700 44 871 -12 200 -65 337 -154 519 -339 116 -116 332 -385 375 -464 17 -33 173 -211 252 -288 206 -201 523 -181 1013 65 358 179 588 242 760 207 233 -47 436 -224 517 -450 31 -90 31 -90 32 -295 0 -205 0 -205 -43 -375 -24 -93 -76 -262 -116 -375 -103 -291 -142 -426 -180 -625 -109 -571 -194 -742 -554 -1109 -442 -451 -891 -740 -1281 -823 -117 -25 -540 -25 -708 0 -212 32 -435 40 -758 28 -164 -6 -319 -15 -344 -20 -25 -5 -90 -14 -145 -21 -194 -21 -447 -80 -669 -155 -138 -46 -155 -54 -486 -205 -556 -255 -972 -312 -1299 -177 -192 79 -615 346 -966 611 -257 193 -367 288 -555 480 -325 330 -507 457 -817 566 -175 62 -469 87 -716 60 -51 -5 -146 -14 -212 -19 -226 -18 -537 -88 -722 -161 -66 -27 -149 -70 -247 -131 -54 -33 -159 -142 -207 -213 -140 -211 -111 -523 79 -856 106 -185 138 -229 375 -518 22 -26 80 -90 130 -142 414 -430 605 -848 692 -1515 35 -274 39 -372 39 -1175 1 -783 5 -873 52 -1066 111 -466 369 -654 898 -654 637 0 875 186 916 715 5 66 14 244 20 395 20 543 68 824 189 1120 120 292 212 419 355 491 80 40 82 41 171 37 93 -5 169 -32 250 -92 17 -13 53 -36 80 -51 102 -59 330 -270 397 -368 37 -54 97 -187 138 -302 73 -208 182 -435 313 -651 283 -468 463 -898 647 -1544 60 -209 164 -529 211 -645 223 -551 593 -803 1309 -892 208 -26 727 -25 884 1 271 45 466 139 573 278 138 180 166 344 144 850 -23 534 -24 621 -7 808 34 375 127 609 356 894 205 255 344 462 437 651 142 286 251 617 318 965 91 472 201 742 415 1014 137 175 248 247 391 254 184 9 328 -70 704 -388 263 -223 469 -361 609 -407 199 -65 627 -13 871 107 366 180 445 540 284 1290 -11 52 -29 133 -39 180 -11 47 -38 173 -60 280 -23 107 -48 224 -56 260 -44 196 -84 508 -84 650 1 280 93 512 346 865 213 297 354 582 439 885 85 304 49 650 -98 945 -113 228 -336 364 -652 400 -253 28 -525 102 -855 230 -47 18 -116 45 -155 60 -779 303 -1272 686 -1524 1183 -72 143 -90 187 -166 392 -131 356 -304 615 -634 948 -191 193 -342 276 -575 317 -105 18 -164 18 -268 -1z M1230 12090 c-505 -123 -873 -492 -1001 -1000 -39 -157 -35 -470 9 -633 72 -265 180 -447 376 -635 365 -348 873 -460 1356 -297 254 85 522 289 670 509 399 594 267 1389 -303 1822 -157 119 -314 190 -537 244 -138 33 -416 28 -570 -10z M7010 10888 c-617 -48 -1187 -506 -1369 -1098 -58 -192 -64 -231 -69 -468 -4 -223 -4 -223 38 -390 197 -791 913 -1294 1725 -1213 117 12 147 18 310 68 103 31 302 127 396 190 448 303 709 795 709 1337 0 574 -326 1114 -843 1394 -260 142 -577 205 -897 180z"/></g></g></svg>',
  );

export function renderLoopbackAuthorizationCompleteHtml(
  stage: LoopbackAuthorizationStage = resolveLoopbackAuthorizationStage(),
): string {
  const stageBrand = stageBrands[stage];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" type="image/svg+xml" href="${MATTR_FAVICON_DATA_URI}" />
    <title>mattr Connect authorization complete</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f7f9;
        color: #17191f;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 32px 16px;
        background:
          radial-gradient(48rem 22rem at 50% -8rem, rgba(47, 119, 235, 0.15), transparent),
          #f6f7f9;
      }
      main {
        width: min(100%, 576px);
        overflow: hidden;
        border: 1px solid rgba(23, 25, 31, 0.1);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 24px 64px rgba(16, 24, 40, 0.16);
      }
      .stage {
        position: relative;
        height: 96px;
        overflow: hidden;
        padding: 22px 24px;
        color: white;
      }
      .stage-latest {
        background:
          radial-gradient(circle at 76% 18%, rgba(136, 204, 255, 0.52), transparent 38%),
          linear-gradient(135deg, #2468df, #172f82);
      }
      .stage-dev {
        background: linear-gradient(145deg, #5ab8fa 0%, #347ff8 46%, #1939bd 100%);
      }
      .stage-dev::before {
        content: "";
        position: absolute;
        inset: 0;
        opacity: 0.42;
        background-image:
          linear-gradient(rgba(234, 246, 255, 0.25) 1px, transparent 1px),
          linear-gradient(90deg, rgba(234, 246, 255, 0.25) 1px, transparent 1px),
          linear-gradient(rgba(234, 246, 255, 0.12) 1px, transparent 1px),
          linear-gradient(90deg, rgba(234, 246, 255, 0.12) 1px, transparent 1px);
        background-size: 32px 32px, 32px 32px, 8px 8px, 8px 8px;
      }
      .stage-nightly {
        background:
          radial-gradient(22rem 8rem at 78% 18%, rgba(81, 101, 216, 0.42), transparent 58%),
          linear-gradient(145deg, #07152f 0%, #151443 52%, #32155b 100%);
      }
      .stage-nightly::before {
        content: "";
        position: absolute;
        inset: 0;
        opacity: 0.78;
        background-image:
          radial-gradient(circle at 12px 12px, rgba(228, 234, 255, 0.9) 0 1px, transparent 1.5px),
          radial-gradient(circle at 38px 28px, rgba(228, 234, 255, 0.58) 0 0.8px, transparent 1.3px),
          radial-gradient(circle at 58px 9px, rgba(200, 215, 255, 0.72) 0 0.9px, transparent 1.4px);
        background-size: 72px 48px, 96px 64px, 128px 56px;
      }
      .stage::after {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 78% 20%, rgba(210, 255, 255, 0.36), transparent 34%),
          linear-gradient(to bottom, transparent 24%, rgba(8, 28, 89, 0.38));
      }
      .stage-content {
        position: relative;
        z-index: 1;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand {
        margin: 0;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      .brand { color: rgba(255, 255, 255, 0.82); }
      .content { padding: 30px 32px 34px; }
      .eyebrow {
        margin: 0 0 8px;
        color: #2866cc;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(26px, 5vw, 34px); line-height: 1.12; letter-spacing: -0.035em; }
      .description { margin: 12px 0 0; color: #646975; font-size: 15px; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        :root { background: #101115; color: #f1f3f7; }
        body { background: radial-gradient(48rem 22rem at 50% -8rem, rgba(55, 102, 210, 0.2), transparent), #101115; }
        main { border-color: rgba(255, 255, 255, 0.1); background: rgba(25, 27, 33, 0.96); }
        .eyebrow { color: #77a8ff; }
        .description { color: #a8adb8; }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="stage stage-${stage}" data-stage="${stage}">
        <div class="stage-content">
          <p class="brand">${stageBrand}</p>
        </div>
      </header>
      <section class="content">
        <p class="eyebrow">Browser authorization complete</p>
        <h1>You're connected</h1>
        <p class="description">Return to your terminal to finish setting up mattr Connect. You can close this window.</p>
      </section>
    </main>
  </body>
</html>`;
}
