CLASS zcl_bench_17 DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES:
      BEGIN OF ty_s_customer,
        id    TYPE string,
        name  TYPE string,
        city  TYPE string,
        phone TYPE string,
      END OF ty_s_customer.
    DATA customers TYPE STANDARD TABLE OF ty_s_customer WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS on_return.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_bench_17 IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_navigated( ).
      on_return( ).
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
            )->a( n = `title` v = `Customers` ).

    DATA(table) = page->ele( `Table`
        )->a( n = `items` v = client->_bind( customers ) ).

    table->ele( `columns`
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Number`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Name`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `City`
        )->end(
        )->ele( `Column`
            )->tag( `Text`
                )->a( n = `text` v = `Phone` ).

    table->ele( `items`
        )->ele( `ColumnListItem`
            )->a( n = `type`  v = `Navigation`
            )->a( n = `press` v = client->_event( val = `OPEN` t_arg = VALUE #( ( `${ID}` ) ) )
            )->ele( `cells`

                )->tag( `Text`
                    )->a( n = `text` v = `{ID}`
                )->tag( `Text`
                    )->a( n = `text` v = `{NAME}`
                )->tag( `Text`
                    )->a( n = `text` v = `{CITY}`
                )->tag( `Text`
                    )->a( n = `text` v = `{PHONE}` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get_event( ).
      WHEN `OPEN`.
        DATA(customer) = VALUE #( customers[ id = client->get_event_arg( ) ] OPTIONAL ).
        IF customer IS NOT INITIAL.
          client->nav_app_call( NEW zcl_bench_17_detail( id    = customer-id
                                                         name  = customer-name
                                                         city  = customer-city
                                                         phone = customer-phone ) ).
        ENDIF.
    ENDCASE.

  ENDMETHOD.

  METHOD on_return.

    " back from the detail app: take over what it saved
    DATA(prev) = client->get_app_prev( ).
    IF prev IS NOT BOUND OR NOT prev IS INSTANCE OF zcl_bench_17_detail.
      RETURN.
    ENDIF.
    DATA(detail) = CAST zcl_bench_17_detail( prev ).
    IF detail->was_saved( ) = abap_true.
      READ TABLE customers ASSIGNING FIELD-SYMBOL(<customer>) WITH KEY id = detail->id.
      IF sy-subrc = 0.
        <customer>-phone = detail->phone.
      ENDIF.
    ENDIF.

  ENDMETHOD.

  METHOD model_init.

    customers = VALUE #( ( id = `C-100` name = `Miller Ltd.`     city = `Bristol` phone = `+44 117 496 0000` )
                         ( id = `C-101` name = `Baker & Sons`    city = `Leeds`   phone = `+44 113 496 0001` )
                         ( id = `C-102` name = `Global Trade AG` city = `Zurich`  phone = `+41 44 668 1800` )
                         ( id = `C-103` name = `Northwind`       city = `Seattle` phone = `+1 206 555 0100` ) ).

  ENDMETHOD.

ENDCLASS.
