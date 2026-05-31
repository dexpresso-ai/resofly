-- Keep ticket status and converted_to_project_id consistent, including when a converted project is deleted.

create or replace function public.normalize_ticket_conversion_state()
returns trigger
language plpgsql
as $$
begin
  if new.converted_to_project_id is null and new.status = 'converted' then
    if TG_OP = 'UPDATE' and old.status is not null and old.status <> 'converted' then
      new.status = old.status;
    else
      new.status = 'new';
    end if;
  end if;

  if new.converted_to_project_id is not null then
    new.status = 'converted';
  end if;

  return new;
end;
$$;

drop trigger if exists tickets_00_conversion_state on public.tickets;
create trigger tickets_00_conversion_state
before insert or update of status, converted_to_project_id on public.tickets
for each row execute function public.normalize_ticket_conversion_state();

update public.tickets
set status = 'new'
where status = 'converted' and converted_to_project_id is null;

update public.tickets
set status = 'converted'
where converted_to_project_id is not null and status <> 'converted';
