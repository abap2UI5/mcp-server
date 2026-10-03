CLASS ltcl_notes DEFINITION FINAL FOR TESTING
  DURATION SHORT
  RISK LEVEL HARMLESS.

  PRIVATE SECTION.
    METHODS insert_and_select FOR TESTING.
ENDCLASS.

CLASS ltcl_notes IMPLEMENTATION.
  METHOD insert_and_select.
    zcl_mcp_notes=>add( id = 'A' text = 'first' ).
    zcl_mcp_notes=>add( id = 'B' text = 'second' ).
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_notes=>count( ) exp = 2 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_mcp_notes=>text_of( 'B' ) exp = 'second' ).
  ENDMETHOD.
ENDCLASS.
