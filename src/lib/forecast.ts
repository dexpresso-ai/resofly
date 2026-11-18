/**
 * De prognose in de app. De rekenregels staan in
 * supabase/functions/_shared/forecast.ts, en dit bestand zet ze alleen door.
 *
 * Waarom geen eigen kopie: Gerrie rekent met dezelfde regels de kaart uit die
 * je goedkeurt ("winst € 48.000 → € 61.500"). Twee kopieën kunnen uit elkaar
 * lopen, en dan toont het scherm na het goedkeuren een ander bedrag dan de
 * kaart beloofde. forecast.test.ts bewaakt dat het gedeelde bestand puur blijft
 * (geen imports), zodat de browserbundel het kan laden.
 */
export * from '../../supabase/functions/_shared/forecast.ts';
