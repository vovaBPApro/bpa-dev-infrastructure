\set ON_ERROR_STOP on

SELECT format('CREATE ROLE %I', :'verify_role')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'verify_role') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL',
  :'verify_role'
) \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM %I', :'verify_database', :'verify_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'verify_database', :'verify_role') \gexec
REVOKE TEMP ON DATABASE :"verify_database" FROM PUBLIC;
SELECT format('GRANT TEMP ON DATABASE %I TO %I', :'verify_database', :'write_role') \gexec
SELECT format('REVOKE ALL ON SCHEMA %I FROM %I', :'verify_schema', :'verify_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA %I TO %I', :'verify_schema', :'verify_role') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', :'verify_schema', :'verify_role') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', :'verify_schema', :'verify_role') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', :'verify_schema', :'verify_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO %I', :'owner_role', :'verify_schema', :'verify_role') \gexec
