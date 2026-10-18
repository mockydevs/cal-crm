-- What the Companies list and its "Add new Company" panel still lacked on the server
-- (record tasks/b12-companies-backend.md): a company's email address, website, postal
-- address and description. Who made a company is already on every row (created_by_kind and
-- created_by_id, 0005), so the "Created By" column needs nothing here.
--
-- Each is null until someone gives it; the application stores blank as null, so "empty"
-- has one meaning in every order and search. The database holds the form of each value;
-- what a person may type (a website without its scheme, a country in either case) is the
-- contract's to normalize. domain (0005) stays as it is: it is what keeps a business from
-- entering one company twice, and what the command bar's company search reads.
alter table crm.companies
  -- Lower-case, the form crm.contact_identities holds an email address in.
  add column email text
    constraint companies_email_format
      check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$' and length(email) <= 320),
  -- As written: with or without http:// or https://.
  add column website text
    constraint companies_website_text
      check (website = btrim(website) and length(website) between 1 and 2000),
  -- One line, as the list shows one "Address" column.
  add column address_line text
    constraint companies_address_line_text
      check (address_line = btrim(address_line) and length(address_line) between 1 and 200),
  add column city text
    constraint companies_city_text
      check (city = btrim(city) and length(city) between 1 and 200),
  add column state text
    constraint companies_state_text
      check (state = btrim(state) and length(state) between 1 and 200),
  add column postal_code text
    constraint companies_postal_code_text
      check (postal_code = btrim(postal_code) and length(postal_code) between 1 and 32),
  -- A two-letter country code, as tenancy.businesses.address holds the business's own.
  add column country text
    constraint companies_country_format check (country ~ '^[A-Z]{2}$'),
  add column description text
    constraint companies_description_text
      check (description = btrim(description) and length(description) between 1 and 5000);
