CLASS zcl_bench_01 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_01 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    client->view_display( `<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc" displayBlock="true" height="100%">` &&
                          `<Shell><Page title="Greeting"><Input value="` && client->_bind( name ) && `"/>` &&
                          `<Button text="Greet" press="` && client->_event( `GREET` ) && `"/></Page></Shell></mvc:View>` ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `GREET`.
        client->message_toast_display( |Hello, { name }!| ).
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
