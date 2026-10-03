CLASS zcl_bench_04 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA quantity TYPE i.

  PROTECTED SECTION.
    CONSTANTS stock TYPE i VALUE 100.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_04 IMPLEMENTATION.

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
            )->a( n = `title` v = `Stock check` ).

    page->ele( `VBox`
        )->a( n = `class` v = `sapUiSmallMargin`

        )->tag( `Label`
            )->a( n = `text`     v = `Quantity of Office chair`
            )->a( n = `labelFor` v = `quantity`
        )->tag( `Input`
            )->a( n = `id`    v = `quantity`
            )->a( n = `type`  v = `Number`
            )->a( n = `value` v = client->_bind( quantity )
        )->tag( `Button`
            )->a( n = `text`  v = `Check availability`
            )->a( n = `type`  v = `Emphasized`
            )->a( n = `press` v = client->_event( `CHECK` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `CHECK`.
        IF quantity <= 0.
          client->message_show( `Enter a quantity greater than zero` ).
        ELSEIF quantity > stock.
          client->message_box_display( text = |Only { stock } pieces are available| type = `warning` ).
        ELSE.
          client->message_box_display( text = |{ quantity } pieces reserved| type = `success` ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
