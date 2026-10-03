CLASS zcl_bench_09 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_unit,
        text TYPE string,
      END OF ty_s_unit,
      ty_t_unit TYPE STANDARD TABLE OF ty_s_unit WITH EMPTY KEY,
      BEGIN OF ty_s_department,
        text  TYPE string,
        nodes TYPE ty_t_unit,
      END OF ty_s_department,
      ty_t_department TYPE STANDARD TABLE OF ty_s_department WITH EMPTY KEY,
      BEGIN OF ty_s_board,
        text  TYPE string,
        nodes TYPE ty_t_department,
      END OF ty_s_board.
    DATA nodes TYPE STANDARD TABLE OF ty_s_board WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_09 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
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
            )->a( n = `title` v = `Organization` ).

    page->ele( `Tree`
        )->a( n = `items` v = client->_bind( nodes )
        )->tag( `StandardTreeItem`
            )->a( n = `title` v = `{TEXT}`
            )->a( n = `type`  v = `Active`
            )->a( n = `press` v = client->_event( val = `NODE_PRESS` t_arg = VALUE #( ( `${TEXT}` ) ) ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `NODE_PRESS`.
        client->message_toast_display( |Selected: { client->get_event_arg( ) }| ).
    ENDCASE.

  ENDMETHOD.

  METHOD model_init.

    nodes = VALUE #(
        ( text = `Board` nodes = VALUE #(
            ( text = `Sales`   nodes = VALUE #( ( text = `Sales Europe` ) ( text = `Sales Americas` ) ) )
            ( text = `Finance` nodes = VALUE #( ( text = `Accounting` ) ( text = `Controlling` ) ) )
            ( text = `IT`      nodes = VALUE #( ( text = `Development` ) ( text = `Operations` ) ) ) ) ) ).

  ENDMETHOD.

ENDCLASS.
