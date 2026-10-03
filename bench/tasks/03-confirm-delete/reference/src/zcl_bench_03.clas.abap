CLASS zcl_bench_03 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA delete_enabled TYPE abap_bool.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_03 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      delete_enabled = abap_true.
      view_display( ).
    ELSEIF client->check_on_navigated( ).
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
            )->a( n = `title` v = `Order 4711` ).

    page->tag( `Text`
        )->a( n = `text`  v = `Customer: Miller Ltd., amount 1,250.00 EUR`
        )->a( n = `class` v = `sapUiSmallMargin` ).

    page->tag( `Button`
        )->a( n = `text`    v = `Delete order`
        )->a( n = `type`    v = `Reject`
        )->a( n = `enabled` v = client->_bind( delete_enabled )
        )->a( n = `press`   v = client->_event( `DELETE` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `DELETE`.
        client->message_box_display( text    = `Do you really want to delete order 4711?`
                                     type    = `confirm`
                                     actions = VALUE #( ( `OK` ) ( `CANCEL` ) )
                                     onclose = `DELETE_CLOSED` ).
      WHEN `DELETE_CLOSED`.
        IF client->get_event_arg( ) = `OK`.
          delete_enabled = abap_false.
          client->message_toast_display( `Order 4711 deleted` ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

ENDCLASS.
