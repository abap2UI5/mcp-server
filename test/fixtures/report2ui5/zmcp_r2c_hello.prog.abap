*&---------------------------------------------------------------------*
*& Report ZMCP_R2C_HELLO - the migrate_report fixture: a selection screen
*& with a default and an OBLIGATORY field, and a WRITE list
*&---------------------------------------------------------------------*
REPORT zmcp_r2c_hello.

PARAMETERS: p_name  TYPE string LOWER CASE OBLIGATORY,
            p_times TYPE i DEFAULT 2.

START-OF-SELECTION.
  WRITE: / 'Hello', p_name.
  DO p_times TIMES.
    WRITE: / 'Line', sy-index.
  ENDDO.
