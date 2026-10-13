-- =============================================================================
-- Bestanden versturen: het boekhouder-hek op de drie interne tabellen
-- =============================================================================
--
-- De rooktest na de deploy van 20261013100000_file_transfers.sql meldde:
-- "Boekhouder-hek ontbreekt op: file_transfer_codes, file_transfer_sessions,
-- storage_purge_queue". Die tabellen hebben RLS aan en bewust géén policy:
-- alleen de service-role (de edge functions en de media-worker) leest en
-- schrijft erin. Er lekte dus niets — maar de regel uit 20261011000000 is dat
-- elke organisatietabel een module gate of het hek heeft, zodat een policy die
-- er later bij komt de boekhouder niet per ongeluk binnenlaat.
--
-- Het hek is restrictive (for all, to authenticated). Zonder permissive policy
-- blijven de tabellen voor ingelogde gebruikers dus precies zo dicht als ze
-- waren; de service-role gaat langs RLS heen en merkt er niets van.
-- =============================================================================

select public.apply_accountant_fence('file_transfer_codes');
select public.apply_accountant_fence('file_transfer_sessions');
select public.apply_accountant_fence('storage_purge_queue');

-- Net als 20261011000000: de migratie controleert zichzelf.
do $$
begin
  if exists (select 1 from public.accountant_fence_gaps()) then
    raise exception 'Boekhouder-hek ontbreekt nog op: %',
      (select string_agg(g, ', ') from public.accountant_fence_gaps() g);
  end if;
end;
$$;
