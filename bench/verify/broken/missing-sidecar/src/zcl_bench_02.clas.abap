CLASS zcl_bench_02 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA count TYPE i.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_02 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_navigated( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory(
        )->ele( n = `View` ns = `mvc`
            )->a( n = `xmlns`        v = `sap.m`
            )->a( n = `xmlns:mvc`    v = `sap.ui.core.mvc`
            )->a( n = `displayBlock` v = `true`
            )->a( n = `height`       v = `100%` ).

    DATA(page) = view->ele( `Shell`
        )->ele( `Page`
            )->a( n = `title` v = `Counter` ).

    page->tag( `ObjectNumber`
        )->a( n = `number` v = client->_bind( count )
        )->a( n = `class`  v = `sapUiSmallMargin` ).

    page->ele( `HBox`
        )->a( n = `class` v = `sapUiSmallMargin`

        )->tag( `Button`
            )->a( n = `text`  v = `+1`
            )->a( n = `press` v = client->_event( `INCREASE` )
        )->tag( `Button`
            )->a( n = `text`  v = `-1`
            )->a( n = `press` v = client->_event( `DECREASE` )
        )->tag( `Button`
            )->a( n = `text`  v = `Reset`
            )->a( n = `press` v = client->_event( `RESET` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `INCREASE`.
        count = count + 1.
      WHEN `DECREASE`.
        IF count = 0.
          client->message_toast_display( `The counter cannot go below zero` ).
        ELSE.
          count = count - 1.
        ENDIF.
      WHEN `RESET`.
        count = 0.
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
