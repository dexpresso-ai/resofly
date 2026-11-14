// De bestandskiezer van de browser: zorgen dat een foto zijn echte naam houdt.
//
// Chrome op Android opent de fotokiezer van Android zodra het accept-attribuut
// alleen foto- en videotypes noemt (`image/jpeg,image/png`, `video/*`). Die
// kiezer geeft de echte bestandsnaam niet door. De browser krijgt een nummer:
// `20261112_143012.jpg` op de telefoon kwam in ResoFly binnen als
// `1000022523.jpg`. Zo stond het in het album, in R2 en in de zip. Ook de vraag
// over dubbele bestanden noemde die nummers, en dan herkende niemand de foto.
//
// Staat er één type tussen dat geen foto of video is, dan opent Chrome de
// gewone bestandenkiezer van Android. Die geeft de echte naam door. Daarvoor
// voegen we een type toe dat bij geen enkel bestand hoort. De kiezer toont
// dus nog steeds alleen de foto's en video's die de galerij wil hebben.
//
// Chrome beslist dit in SelectFileDialog.java (isSupportedPhotoPickerTypes):
// elk type moet met `image/` of `video/` beginnen, anders geen fotokiezer.
// `application/octet-stream` werkt ook, maar dan filtert Chrome niet meer en
// zie je in de kiezer ook pdf's en downloads.

/** Een type dat bij geen bestand hoort. Het houdt de fotokiezer van Android dicht. */
export const REAL_FILE_NAME_TYPE = 'application/x-resofly-echte-bestandsnaam';

function isAndroid(userAgent: string): boolean {
  return /android/i.test(userAgent);
}

/**
 * Het accept-attribuut voor een uploadveld waarbij de bestandsnaam ertoe doet.
 * Alleen op Android verandert er iets: op de computer en op de iPhone gaat de
 * echte naam al mee, en daar blijft de kiezer zoals hij was.
 */
export function acceptWithRealFileNames(accept: string, userAgent: string): string {
  if (!isAndroid(userAgent)) return accept;
  const types = accept.split(',').map(type => type.trim()).filter(Boolean);
  // Zonder accept opent Chrome de fotokiezer al niet.
  if (types.length === 0) return accept;
  // Staat er al een ander type tussen (een pdf, een xml), dan ook niet.
  const mediaOnly = types.every(type => !type.includes('/') || /^(image|video)\//i.test(type));
  if (!mediaOnly) return accept;
  return [...types, REAL_FILE_NAME_TYPE].join(',');
}

/** Zoals hierboven, voor de browser waarin de app nu draait. */
export function fileInputAccept(accept: string): string {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return acceptWithRealFileNames(accept, userAgent);
}
