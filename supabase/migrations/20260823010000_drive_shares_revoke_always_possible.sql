-- ============================================================
-- ResoFly — Intrekken van een deling moet altijd kunnen
-- Date: 2026-08-23
--
-- Aanleiding:
-- `enforce_drive_share_rules` (20260823000000) controleert bij elke wijziging
-- opnieuw of de ontvanger nog mag: een contactpersoon moet actief zijn én
-- portaaltoegang hebben, een collega moet nog actief lid zijn. Dat is precies
-- goed bij het aanmaken en bij het weer scherp zetten van een deling.
--
-- Maar het gold ook bij INTREKKEN. Zet je een contactpersoon op inactief (of haal
-- je zijn portaaltoegang weg) en wil je daarna zijn deling stoppen, dan weigerde
-- de trigger dat met "heeft geen portaaltoegang" — en zat je vast aan precies de
-- deling die je kwijt wilde. Hetzelfde bij een collega die de organisatie heeft
-- verlaten.
--
-- Oplossing:
-- Een rij die ingetrokken wordt (of ingetrokken blijft) geeft nergens toegang,
-- dus daar valt niets te bewaken: laat hem door zonder controle. De achterdeur
-- die deze trigger dichthoudt blijft dicht, want:
--   - een INSERT kan niet al ingetrokken aankomen (revoked_at wordt op null gezet),
--   - weer scherp zetten (revoked_at terug op null) loopt gewoon langs alle regels.
--
-- Verder ongewijzigd. Veilig om meermaals te draaien.
-- ============================================================

begin;

create or replace function public.enforce_drive_share_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx      record;
  v_contact  public.client_contacts;
  v_member   record;
begin
  -- Een deling mag NOOIT al ingetrokken worden aangemaakt. Zonder deze regel kun
  -- je de hele controle hieronder overslaan met een insert die revoked_at al
  -- gevuld heeft, en daarna met één update op revoked_at de deling alsnog scherp
  -- zetten. Dat is precies de achterdeur die deze trigger moet dichthouden.
  if TG_OP = 'INSERT' then
    new.revoked_at := null;
    new.revoked_by := null;
  elsif new.revoked_at is not null then
    -- Wordt ingetrokken, of is dat al: die rij geeft nergens toegang. Intrekken
    -- moet ALTIJD lukken — ook als de contactpersoon intussen inactief is of zijn
    -- portaaltoegang kwijt is, en ook als de collega de organisatie heeft
    -- verlaten. Weer scherp zetten (revoked_at terug op null) valt hier niet
    -- onder en loopt dus gewoon langs alle regels hieronder.
    return new;
  end if;

  new.recipient_name := nullif(btrim(coalesce(new.recipient_name, '')), '');
  new.message := nullif(btrim(coalesce(new.message, '')), '');
  new.recipient_email := public.normalize_client_lookup_value(new.recipient_email);

  select * into v_ctx
  from public.drive_item_client(new.organization_id, new.item_type, new.item_id);

  -- De klantcontext komt altijd van de server. Wat de client meestuurde telt niet.
  new.client_id := v_ctx.client_id;
  new.project_id := v_ctx.project_id;
  new.item_name := coalesce(nullif(btrim(coalesce(new.item_name, '')), ''), v_ctx.item_name);

  if new.recipient_kind = 'contact' then
    if new.client_id is null then
      raise exception 'Dit item hoort niet bij een klantdossier, dus er is geen contactpersoon om mee te delen. Kies een collega of een deellink.'
        using errcode = '23514';
    end if;

    select * into v_contact from public.client_contacts cc where cc.id = new.client_contact_id;
    if not found then
      raise exception 'Deze contactpersoon bestaat niet (meer).' using errcode = '02000';
    end if;

    -- HET SLOT: klantgerelateerd → alleen een geregistreerde contactpersoon van
    -- diezelfde klant, binnen dezelfde organisatie.
    if v_contact.organization_id <> new.organization_id or v_contact.client_id <> new.client_id then
      raise exception 'Dit bestand hoort bij klantdossier “%”. Het mag alleen worden gedeeld met een geregistreerde contactpersoon van diezelfde klant.',
        coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
    end if;
    if not v_contact.is_active then
      raise exception 'Contactpersoon “%” staat op inactief. Activeer die eerst bij de klant.', v_contact.name
        using errcode = '23514';
    end if;
    -- Zonder portaaltoegang komt deze persoon het portaal niet in en ziet hij het
    -- gedeelde bestand dus nooit. Dezelfde eis als portal_drive_shares_for_email:
    -- één regel aan beide kanten, anders lukt het delen wel maar gebeurt er niets.
    if not v_contact.gives_portal_access then
      raise exception 'Contactpersoon “%” heeft geen portaaltoegang. Zet die eerst aan bij de klant, anders kan hij het bestand niet openen.', v_contact.name
        using errcode = '23514';
    end if;

    new.recipient_email := public.normalize_client_lookup_value(v_contact.email);
    new.recipient_name := v_contact.name;
    new.member_user_id := null;
    new.token_hash := null;

  elsif new.recipient_kind = 'member' then
    select m.user_id, m.email into v_member
    from public.organization_members m
    where m.user_id = new.member_user_id
      and m.organization_id = new.organization_id
      and m.status = 'active';
    if not found then
      raise exception 'Deze collega is geen actief lid van deze organisatie.' using errcode = '42501';
    end if;

    new.recipient_email := coalesce(
      public.normalize_client_lookup_value(v_member.email),
      new.recipient_email
    );
    new.client_contact_id := null;
    new.token_hash := null;

  else -- 'link'
    -- Klantgerelateerd? Dan geen open deellink. Dit is de andere helft van het slot.
    if new.client_id is not null then
      raise exception 'Dit bestand hoort bij klantdossier “%”. Klantgerelateerde bestanden mogen alleen worden gedeeld met de geregistreerde contactpersonen van die klant, niet via een open deellink.',
        coalesce(v_ctx.client_name, 'onbekend') using errcode = '42501';
    end if;
    if new.recipient_email is null then
      raise exception 'Vul een geldig e-mailadres in om een deellink te versturen.' using errcode = '23514';
    end if;
    if new.recipient_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      raise exception 'Vul een geldig e-mailadres in om een deellink te versturen.' using errcode = '23514';
    end if;
    if nullif(btrim(coalesce(new.token_hash, '')), '') is null then
      raise exception 'Een deellink kan niet zonder token worden aangemaakt.' using errcode = '23514';
    end if;
    new.client_contact_id := null;
    new.member_user_id := null;
  end if;

  return new;
end;
$$;

commit;
