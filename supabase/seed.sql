-- Run after logging in at least once. Replace YOUR_USER_ID with auth.users.id.
insert into public.clients (user_id,name,client_code,contact_name,email,color,status,tags,value_eur)
values ('YOUR_USER_ID','Acme BV','KL-001','Jan de Vries','jan@acme.nl','#FFD966','active',array['VIP','Klant'],45000);
