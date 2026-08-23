import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, RotateCcw, Search, SlidersHorizontal } from 'lucide-react';
import { Select } from './Ui';

/* ── Eén zoek- en filterblok voor élke tabel ───────────────────────────────
 * Tickets, klanten, offertes, facturen, projecten en campagnes hadden alle
 * zes hun eigen zoekbalk: de een een los invoerveld, de ander een kaart met
 * zeven dropdowns, en twee ervan helemaal niets. Dit blok is de enige plek
 * waar dat nog getekend wordt, zodat "zoeken" op elke tabel hetzelfde doet
 * en hetzelfde oplevert.
 *
 * Het blok filtert zelf niets — het toont alleen bedieningselementen en meldt
 * wijzigingen terug. Elk scherm houdt zijn eigen filterlogica, want wat "open"
 * of "vervallen" betekent verschilt per soort rij.
 *
 * Opbouw, van boven naar beneden:
 *   0. optioneel de paginakop zélf (titel + knoppen), zie `header`
 *   1. vrij zoekveld + een telkaart die zegt hoeveel er van het totaal over is
 *   2. snelfilters als aanvinkbare chips, mét het aantal dat ze zouden tonen
 *   3. dropdowns en datum-/bedragvelden (op een telefoon achter "Meer filters")
 *   4. een regel die zegt hoeveel filters er aanstaan, met één knop om te wissen
 */

/** De paginakop mág in dit blok. Twee losse kaarten boven elkaar — een titelbalk
 *  en daaronder een zoekblok — kostten samen zo'n 350px voordat het eerste rijtje
 *  in beeld kwam, terwijl beide over hetzelfde gaan. Wordt dit meegegeven, dan
 *  trekt het blok zichzelf compacter: het zoeklabel wordt een vergrootglas ín het
 *  veld, de dropdowns schuiven naast het zoekveld en de telkaart wordt een pil.
 *  Zonder `header` blijft het blok precies zoals het was. */
export type SearchFilterHeader = {
  eyebrow?: string;
  title: string;
  /** Regel onder de titel — houd dit de vaste totalen; de telpil rechts van het
   *  zoekveld zegt al wat het filter overlaat. */
  meta?: ReactNode;
  actions?: ReactNode;
};

/** Een snelfilter: één vinkje dat een veelgebruikte vraag beantwoordt. Het
 *  getal telt over álle rijen, niet over de al gefilterde selectie — het zegt
 *  "hoeveel zijn er zo?" en zakt dus niet naar 0 als er iets anders aanstaat. */
export type FilterChip = { key: string; label: string; title?: string; count: number };

export type FilterFieldOption = { value: string; label: string };

/** Een veld in het uitklapbare raster. Met `options` wordt het een keuzelijst
 *  (die vanaf tien opties vanzelf een zoekveld krijgt), zonder `options` een
 *  vrij invoerveld — gebruikt voor datums en bedragen. Leeg = geen filter. */
export type FilterField = {
  key: string;
  label: string;
  value: string;
  options?: FilterFieldOption[];
  searchable?: boolean;
  searchPlaceholder?: string;
  type?: string;
  inputMode?: 'decimal';
  placeholder?: string;
};

export function SearchFilterPanel({
  ariaLabel,
  className = '',
  header,
  query,
  queryPlaceholder,
  onQueryChange,
  visibleCount,
  totalCount,
  noun,
  summary,
  chips = [],
  activeChips = [],
  onChipToggle,
  fields = [],
  onFieldChange,
  onReset,
}: {
  ariaLabel: string;
  /** Extra klassen op de kaart. `is-wide` haalt de 1180px-cap eraf, voor
   *  pagina's waarvan de tabel zelf ook tot de rand doorloopt. `is-bar`
   *  perst het blok tot één commandobalk: de veldlabels gaan uit beeld en
   *  de keuzelijsten worden pillen die naast het zoekveld passen. Dat kan
   *  alleen als élk veld een keuzelijst is die zelf al zegt wat hij doet
   *  ("Alle klanten") — bij een leeg datum- of bedragveld is het label
   *  onmisbaar, dus die pagina's laten hem staan. */
  className?: string;
  /** Paginakop in dezelfde kaart, in plaats van een losse titelbalk erboven. */
  header?: SearchFilterHeader;
  query: string;
  queryPlaceholder: string;
  onQueryChange: (value: string) => void;
  visibleCount: number;
  totalCount: number;
  /** Meervoud van wat er in de tabel staat: "tickets", "klanten", "offertes". */
  noun: string;
  /** Optionele extra rechts in de telkaart, bijvoorbeeld "€ 12.345 totaal". */
  summary?: string;
  chips?: FilterChip[];
  activeChips?: string[];
  onChipToggle?: (key: string) => void;
  fields?: FilterField[];
  onFieldChange?: (key: string, value: string) => void;
  onReset: () => void;
}) {
  // Op een telefoon kostten de dropdowns ruim de helft van het blok, terwijl de
  // snelfilters erboven het meeste werk doen. Ze zitten daar achter één knop; op
  // een breed scherm staan ze gewoon open (CSS regelt dat, de knop is daar
  // onzichtbaar en het raster negeert `is-collapsed`).
  const [showFields, setShowFields] = useState(false);
  const fieldsId = useId();

  const activeFieldCount = fields.filter(field => field.value !== '').length;
  const activeFilterCount = (query.trim() === '' ? 0 : 1) + activeFieldCount + activeChips.length;

  return <section className={`finance-search-card${header ? ' has-head' : ''} ${className}`.trim()} aria-label={ariaLabel}>
    {header && <div className="finance-search-head">
      <div className="fsh-text">
        {header.eyebrow && <p className="eyebrow">{header.eyebrow}</p>}
        <h2>{header.title}</h2>
        {header.meta && <span>{header.meta}</span>}
      </div>
      {header.actions && <div className="fsh-actions">{header.actions}</div>}
    </div>}

    <div className="finance-search-main">
      <label className="finance-search-query">
        <span><Search size={15}/> Snel zoeken</span>
        <input
          className="form-input"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder={queryPlaceholder}
          autoComplete="off"
        />
      </label>
      <div className="finance-search-result-card">
        <SlidersHorizontal size={16}/>
        <div><strong>{visibleCount} van {totalCount}</strong><span>{noun} zichtbaar</span></div>
        {summary && <small>{summary}</small>}
      </div>
    </div>

    {chips.length > 0 && <div className="finance-search-chips" role="group" aria-label="Snelfilters">
      {chips.map(chip => {
        const isActive = activeChips.includes(chip.key);
        return <label key={chip.key} className={`finance-search-chip${isActive ? ' is-active' : ''}${!isActive && chip.count === 0 ? ' is-empty' : ''}`} title={chip.title}>
          <input type="checkbox" checked={isActive} onChange={() => onChipToggle?.(chip.key)} />
          <span className="fsc-box" aria-hidden="true"><Check size={11} strokeWidth={3}/></span>
          <span className="fsc-label">{chip.label}</span>
          <span className="fsc-count">{chip.count}</span>
        </label>;
      })}
    </div>}

    {fields.length > 0 && <>
      <button type="button" className="finance-search-toggle" onClick={() => setShowFields(value => !value)} aria-expanded={showFields} aria-controls={fieldsId}>
        <SlidersHorizontal size={13}/> {showFields ? 'Minder filters' : 'Meer filters'}
        {activeFieldCount > 0 && <span className="fst-count">{activeFieldCount}</span>}
      </button>

      <div id={fieldsId} className={`finance-search-grid${showFields ? '' : ' is-collapsed'}`}>
        {fields.map(field => <label className="field finance-search-field" key={field.key}>
          <span>{field.label}</span>
          {field.options
            ? <Select
                className="form-select"
                value={field.value}
                searchable={field.searchable}
                searchPlaceholder={field.searchPlaceholder}
                onChange={event => onFieldChange?.(field.key, event.target.value)}
              >
                {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            : <input
                className="form-input"
                type={field.type}
                inputMode={field.inputMode}
                value={field.value}
                placeholder={field.placeholder}
                onChange={event => onFieldChange?.(field.key, event.target.value)}
              />}
        </label>)}
      </div>
    </>}

    {activeFilterCount > 0 && <div className="finance-search-active-row">
      <span>{activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} actief</span>
      <button type="button" onClick={onReset}><RotateCcw size={14}/> Filters wissen</button>
    </div>}
  </section>;
}
