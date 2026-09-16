insert into public.profiles (
  id,
  display_name,
  family_display_name
)
values (
  '7fbce85b-3e5d-44e7-bcc9-3f780068d126',
  'George',
  'Dad'
)
on conflict (id) do update
set
  display_name = excluded.display_name,
  family_display_name = excluded.family_display_name;