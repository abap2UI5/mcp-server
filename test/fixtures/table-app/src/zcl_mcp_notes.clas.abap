CLASS zcl_mcp_notes DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS add
      IMPORTING id   TYPE zmcp_note-id
                text TYPE zmcp_note_text.
    CLASS-METHODS count
      RETURNING VALUE(result) TYPE i.
    CLASS-METHODS text_of
      IMPORTING id            TYPE zmcp_note-id
      RETURNING VALUE(result) TYPE zmcp_note_text.
ENDCLASS.

CLASS zcl_mcp_notes IMPLEMENTATION.
  METHOD add.
    DATA ls_note TYPE zmcp_note.
    ls_note-id = id.
    ls_note-text = text.
    INSERT zmcp_note FROM ls_note.
  ENDMETHOD.

  METHOD count.
    SELECT COUNT(*) FROM zmcp_note INTO result.
  ENDMETHOD.

  METHOD text_of.
    SELECT SINGLE text FROM zmcp_note WHERE id = @id INTO @result.
  ENDMETHOD.
ENDCLASS.
